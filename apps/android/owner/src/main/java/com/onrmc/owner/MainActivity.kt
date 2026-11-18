package com.onrmc.owner

import android.os.Bundle
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.onrmc.core.Api
import com.onrmc.core.ApiException
import com.onrmc.core.Bad
import com.onrmc.core.Good
import com.onrmc.core.KeyValue
import com.onrmc.core.Label
import com.onrmc.core.LoginScreen
import com.onrmc.core.OnrmcTheme
import com.onrmc.core.SectionCard
import com.onrmc.core.Session
import com.onrmc.core.SubscriptionBanner
import com.onrmc.core.Warn
import com.onrmc.core.arr
import com.onrmc.core.inr
import com.onrmc.core.list
import com.onrmc.core.num
import com.onrmc.core.numOrNull
import com.onrmc.core.o
import com.onrmc.core.pretty
import com.onrmc.core.qty
import com.onrmc.core.str
import com.onrmc.core.strOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Marker

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Configuration.getInstance().apply {
            userAgentValue = packageName // required by the OpenStreetMap tile servers
            osmdroidBasePath = java.io.File(filesDir, "osmdroid")
            osmdroidTileCache = java.io.File(cacheDir, "osm-tiles")
        }
        val session = Session(this)
        val api = Api(session)
        setContent {
            OnrmcTheme {
                var signedIn by remember { mutableStateOf(session.signedIn) }
                if (!signedIn) LoginScreen("Owner", session, api, setOf("OWNER")) { signedIn = true }
                else Home(session, api, onSignOut = { session.clear(); signedIn = false })
            }
        }
    }
}

private data class Snapshot(
    val dash: JsonObject?, val margin: JsonObject?, val fleet: List<JsonObject>, val sub: JsonObject?,
    val maintenance: JsonObject?, val qcDue: Int?,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Home(session: Session, api: Api, onSignOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var data by remember { mutableStateOf<Snapshot?>(null) }
    var loading by remember { mutableStateOf(false) }

    suspend fun load() {
        loading = true
        try {
            data = coroutineScope {
                // optional parts must not break the screen if one fails
                suspend fun <T> soft(block: suspend () -> T): T? = try { block() } catch (e: ApiException) { if (e.unauthorized) throw e; null }
                val dash = async { api.get("/analytics/dashboard") as JsonObject }
                val margin = async { soft { api.get("/analytics/margin") as JsonObject } }
                val fleet = async { soft { api.get("/gps/live").list() } }
                val sub = async { soft { api.get("/subscription/status") as JsonObject } }
                val maint = async { soft { api.get("/fleet/maintenance") as JsonObject } }
                val qc = async { soft { api.get("/qc/cube-sets?pending=true").list().size } }
                Snapshot(dash.await(), margin.await(), fleet.await() ?: emptyList(), sub.await(), maint.await(), qc.await())
            }
        } catch (e: ApiException) {
            if (e.unauthorized) onSignOut() else snack.showSnackbar(e.message ?: "Error")
        } finally { loading = false }
    }
    LaunchedEffect(Unit) { while (true) { load(); delay(60_000) } }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Column { Text("Today", fontWeight = FontWeight.Bold); Text(session.user?.str("tenantName").orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                    actions = { TextButton(onClick = onSignOut) { Text("Sign out") } },
                )
                SubscriptionBanner(data?.sub?.strOrNull("message"), data?.sub?.str("state") == "PAUSED")
            }
        },
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        PullToRefreshBox(isRefreshing = loading, onRefresh = { scope.launch { load() } }, modifier = Modifier.fillMaxSize().padding(pad)) {
            val d = data
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (d == null) { Text(if (loading) "Loading…" else "Pull down to load", color = MaterialTheme.colorScheme.onSurfaceVariant); return@Column }
                d.dash?.let { dash ->
                    val today = dash.o("today")
                    TileRow(Tile("Produced", "${qty(today?.num("producedM3") ?: 0.0)} m³"), Tile("Delivered", "${qty(today?.num("deliveredM3") ?: 0.0)} m³", "${today?.num("trips")?.toInt() ?: 0} trips"))
                    TileRow(Tile("Billed", inr(today?.num("sales") ?: 0.0)), Tile("Collected", inr(today?.num("collections") ?: 0.0), tone = Good))
                    TileRow(Tile("Receivable", inr(dash.num("receivable")), tone = Warn), Tile("Open orders", dash.num("pendingOrders").toInt().toString()))
                    val low = dash.arr("lowStock")
                    if (low.isNotEmpty()) SectionCard(title = "Low stock") { Text(low.joinToString(", ") { it.str("name") }, color = Bad, fontWeight = FontWeight.SemiBold) }
                }
                d.margin?.let { m ->
                    val t = m.o("totals")
                    SectionCard(title = "This month · private") {
                        KeyValue("Revenue (ex-GST)", inr(t?.num("revenue") ?: 0.0))
                        KeyValue("Materials", inr(t?.num("materialCost") ?: 0.0))
                        KeyValue("Trip diesel", inr(t?.num("diesel") ?: 0.0))
                        val margin = t?.num("margin") ?: 0.0
                        KeyValue("Gross margin", "${inr(margin)} (${"%.1f".format(t?.num("marginPct") ?: 0.0)}%)", bold = true, valueColor = if (margin >= 0) Good else Bad)
                        KeyValue("Cost per m³", inr(t?.num("costPerM3") ?: 0.0))
                        KeyValue("Overheads", inr(m.num("overhead")))
                        KeyValue("Net after overheads", inr(m.num("netAfterOverhead")), bold = true)
                    }
                }
                Alerts(d)
                val located = d.fleet.filter { it.numOrNull("lastLat") != null }
                val onRoad = d.fleet.filter { v -> v.arr("challans").firstOrNull()?.str("status")?.let { it != "DELIVERED" } == true }
                SectionCard(title = "Trucks on road (${onRoad.size})") {
                    if (located.isNotEmpty()) FleetMap(located)
                    if (onRoad.isEmpty()) Text("None right now", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    onRoad.forEach { v ->
                        val c = v.arr("challans").first()
                        KeyValue("${v.str("number")} · ${c.o("order")?.o("customer")?.str("name")}", pretty(c.str("status")))
                    }
                }
            }
        }
    }
}

@Composable
private fun Alerts(d: Snapshot) {
    val overdue = d.maintenance?.arr("vehicles")?.sumOf { v -> v.arr("schedules").count { it.str("status") == "OVERDUE" } } ?: 0
    val soon = d.maintenance?.arr("vehicles")?.sumOf { v -> v.arr("schedules").count { it.str("status") == "DUE_SOON" } } ?: 0
    val qc = d.qcDue ?: 0
    if (overdue + soon + qc == 0) return
    SectionCard(title = "Needs attention") {
        if (overdue > 0) KeyValue("Truck services overdue", overdue.toString(), bold = true, valueColor = Bad)
        if (soon > 0) KeyValue("Truck services due this week", soon.toString(), valueColor = Warn)
        if (qc > 0) KeyValue("Cube tests due", qc.toString(), valueColor = Warn)
    }
}

private data class TileData(val k: String, val v: String, val sub: String? = null, val tone: Color = Color.Unspecified)
private fun Tile(k: String, v: String, sub: String? = null, tone: Color = Color.Unspecified) = TileData(k, v, sub, tone)

@Composable
private fun TileRow(a: TileData, b: TileData) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        for (t in listOf(a, b)) SectionCard(Modifier.weight(1f)) {
            Label(t.k)
            Text(t.v, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = if (t.tone == Color.Unspecified) MaterialTheme.colorScheme.onSurface else t.tone)
            t.sub?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp) }
        }
    }
}

/** OpenStreetMap (no API key) with one marker per truck that has reported a position. */
@Composable
private fun FleetMap(trucks: List<JsonObject>) {
    val ctx = LocalContext.current
    val map = remember {
        MapView(ctx).apply {
            setTileSource(TileSourceFactory.MAPNIK)
            setMultiTouchControls(true)
            // let the map pan inside the scrolling page
            setOnTouchListener { v, e -> v.parent.requestDisallowInterceptTouchEvent(e.action != MotionEvent.ACTION_UP); false }
        }
    }
    DisposableEffect(Unit) { map.onResume(); onDispose { map.onPause(); map.onDetach() } }
    AndroidView(factory = { map }, modifier = Modifier.fillMaxWidth().height(240.dp).clip(RoundedCornerShape(12.dp))) { m ->
        m.overlays.clear()
        val pts = trucks.map { GeoPoint(it.num("lastLat"), it.num("lastLng")) }
        trucks.zip(pts).forEach { (t, p) ->
            m.overlays.add(Marker(m).apply {
                position = p; title = t.str("number")
                snippet = t.arr("challans").firstOrNull()?.let { c -> "${pretty(c.str("status"))} · ${c.o("order")?.o("customer")?.str("name")}" } ?: "Idle"
                setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
            })
        }
        if (pts.size == 1) { m.controller.setZoom(14.0); m.controller.setCenter(pts[0]) }
        else if (pts.size > 1) m.post { runCatching { m.zoomToBoundingBox(BoundingBox.fromGeoPoints(pts).increaseByScale(1.3f), false) } }
        m.invalidate()
    }
}
