package com.onrmc.driver

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.onrmc.core.ApiException
import com.onrmc.core.Bad
import com.onrmc.core.Good
import com.onrmc.core.LoginScreen
import com.onrmc.core.OnrmcTheme
import com.onrmc.core.Pill
import com.onrmc.core.SectionCard
import com.onrmc.core.SubscriptionBanner
import com.onrmc.core.Warn
import com.onrmc.core.list
import com.onrmc.core.num
import com.onrmc.core.numOrNull
import com.onrmc.core.o
import com.onrmc.core.obj
import com.onrmc.core.pretty
import com.onrmc.core.qty
import com.onrmc.core.str
import com.onrmc.core.strOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val session = Services.session(this)
        val api = Services.api(this)
        setContent {
            OnrmcTheme {
                var signedIn by remember { mutableStateOf(session.signedIn) }
                var banner by remember { mutableStateOf<JsonObject?>(null) }
                if (!signedIn) LoginScreen("Driver", session, api, setOf("DRIVER")) { r -> banner = r.o("subscription"); signedIn = true }
                else TripsScreen(initialBanner = banner, onSignOut = {
                    TripLocationService.finish(this)
                    session.clear(); signedIn = false
                })
            }
        }
    }
}

/** The step a driver taps next, and what it sets. */
private val NEXT = mapOf(
    "ASSIGNED" to ("Loaded at plant" to "LOADED"),
    "LOADED" to ("Start trip" to "IN_TRANSIT"),
    "IN_TRANSIT" to ("Reached site" to "AT_SITE"),
    "AT_SITE" to ("Start unloading" to "UNLOADING"),
    "UNLOADING" to ("Delivered" to "DELIVERED"),
    "DELIVERED" to ("Back at plant" to "RETURNED"),
)
private val TRACKED = setOf("LOADED", "IN_TRANSIT", "AT_SITE", "UNLOADING", "DELIVERED")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TripsScreen(initialBanner: JsonObject?, onSignOut: () -> Unit) {
    val ctx = LocalContext.current
    val api = remember { Services.api(ctx) }
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var trips by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var banner by remember { mutableStateOf(initialBanner) }
    var deliver by remember { mutableStateOf<JsonObject?>(null) }
    var pendingStart by remember { mutableStateOf<JsonObject?>(null) }
    var tracking by remember { mutableStateOf(TripStore.get(ctx)) }

    suspend fun load() {
        loading = true
        try {
            trips = api.get("/driver/trips").list(); loaded = true
            runCatching { banner = api.get("/subscription/status") as? JsonObject }
        } catch (e: ApiException) {
            if (e.unauthorized) onSignOut() else snack.showSnackbar(e.message ?: "Error")
        } finally { loading = false }
    }

    fun startTracking(t: JsonObject) {
        val trip = ActiveTrip(t.str("id"), t.o("vehicle")?.str("id").orEmpty(), "${t.str("number")} · ${t.o("vehicle")?.str("number")}")
        TripLocationService.start(ctx, trip); tracking = trip
    }

    // Location permission flow: precise location → "Allow all the time" (Android 10+) → notifications (Android 13+).
    val bgLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        pendingStart?.let { startTracking(it) }; pendingStart = null
        if (!TripLocationService.hasBackground(ctx)) scope.launch { snack.showSnackbar("Tip: set location to \"Allow all the time\" so tracking continues with the screen off.") }
    }
    val fgLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val t = pendingStart
        if (res[Manifest.permission.ACCESS_FINE_LOCATION] != true) {
            pendingStart = null
            scope.launch { snack.showSnackbar("Location is needed so dispatch can see the truck.") }
        } else if (t != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !TripLocationService.hasBackground(ctx)) bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            else { startTracking(t); pendingStart = null }
        }
    }
    fun ensureTracking(t: JsonObject) {
        if (TripLocationService.hasLocation(ctx) && TripLocationService.hasBackground(ctx)) { startTracking(t); return }
        pendingStart = t
        val perms = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION); add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (TripLocationService.hasLocation(ctx) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        else fgLauncher.launch(perms.toTypedArray())
    }

    fun advance(t: JsonObject, extra: Map<String, Any?> = emptyMap()) {
        val (_, next) = NEXT[t.str("status")] ?: return
        scope.launch {
            try {
                api.post("/driver/trips/${t.str("id")}/status", obj("status" to next, *extra.toList().toTypedArray()))
                if (next == "LOADED" || next == "IN_TRANSIT") ensureTracking(t)
                if (next == "RETURNED") { TripLocationService.finish(ctx); tracking = null }
                load()
            } catch (e: ApiException) { snack.showSnackbar(e.message ?: "Error") }
        }
    }

    LaunchedEffect(Unit) {
        while (true) { load(); delay(30_000) }
    }
    // Resume tracking if the app was reopened mid-trip (e.g. after the phone restarted).
    LaunchedEffect(trips) {
        val active = trips.firstOrNull { it.str("status") in TRACKED }
        if (active != null && TripStore.get(ctx) == null && TripLocationService.hasLocation(ctx)) startTracking(active)
        if (loaded && active == null && TripStore.get(ctx) != null) { TripLocationService.finish(ctx); tracking = null }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Column { Text("My trips", fontWeight = FontWeight.Bold); Text(Services.session(ctx).user?.str("name").orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                    actions = { TextButton(onClick = onSignOut) { Text("Sign out") } },
                )
                SubscriptionBanner(banner?.strOrNull("message"), banner?.str("state") == "PAUSED")
                if (tracking != null) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Pill("● Sharing location", Good)
                    if (!TripLocationService.hasBackground(ctx)) TextButton(onClick = {
                        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
                    }) { Text("Set location to \"Allow all the time\"", fontSize = 12.sp) }
                }
            }
        },
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        PullToRefreshBox(isRefreshing = loading, onRefresh = { scope.launch { load() } }, modifier = Modifier.fillMaxSize().padding(pad)) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (loaded && trips.isEmpty()) item {
                    Box(Modifier.fillMaxWidth().padding(top = 60.dp)) { Text("No trips assigned right now.\nPull down to refresh.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
                }
                items(trips, key = { it.str("id") }) { t -> TripCard(t, onNext = { if (t.str("status") == "UNLOADING") deliver = t else advance(t) }) }
            }
        }
    }

    deliver?.let { t ->
        var receiver by remember(t) { mutableStateOf("") }
        var diesel by remember(t) { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { deliver = null },
            title = { Text("Delivered ${qty(t.num("quantityM3"))} m³?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(receiver, { receiver = it }, label = { Text("Received by (name)") }, singleLine = true)
                    OutlinedTextField(diesel, { diesel = it.filter { c -> c.isDigit() || c == '.' } }, label = { Text("Diesel filled ₹ (if any)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                }
            },
            confirmButton = {
                Button(onClick = {
                    val extra = buildMap<String, Any?> {
                        if (receiver.isNotBlank()) put("podName", receiver.trim())
                        diesel.toDoubleOrNull()?.let { put("dieselCost", it) }
                    }
                    advance(t, extra); deliver = null
                }) { Text("Confirm delivery") }
            },
            dismissButton = { TextButton(onClick = { deliver = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun TripCard(t: JsonObject, onNext: () -> Unit) {
    val ctx = LocalContext.current
    val order = t.o("order")
    val site = order?.o("site")
    val customer = order?.o("customer")
    val status = t.str("status")
    SectionCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("${order?.o("mixDesign")?.str("grade")} · ${qty(t.num("quantityM3"))} m³", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Pill(pretty(status), when (status) { "ASSIGNED" -> Warn; "DELIVERED" -> Good; else -> MaterialTheme.colorScheme.primary })
        }
        Text(customer?.str("name").orEmpty(), fontWeight = FontWeight.Medium)
        Text(listOfNotNull(site?.str("name"), site?.strOrNull("address"), site?.strOrNull("city")).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("${t.str("number")} · Truck ${t.o("vehicle")?.str("number")}", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val lat = site?.numOrNull("lat"); val lng = site?.numOrNull("lng")
            OutlinedButton(onClick = {
                val uri = if (lat != null && lng != null) Uri.parse("google.navigation:q=$lat,$lng")
                else Uri.parse("geo:0,0?q=" + Uri.encode(listOfNotNull(site?.str("name"), site?.strOrNull("address"), site?.strOrNull("city")).joinToString(", ")))
                runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            }) { Icon(Icons.Default.Place, null); Text(" Navigate") }
            customer?.strOrNull("phone")?.let { phone ->
                OutlinedButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }) { Icon(Icons.Default.Call, null); Text(" Call") }
            }
        }
        NEXT[status]?.let { (label, _) ->
            Button(onClick = onNext, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(label, fontSize = 16.sp) }
        }
        if (status == "CANCELLED") Text("Cancelled by dispatch", color = Bad)
    }
}
