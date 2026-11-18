package com.onrmc.driver

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.onrmc.core.ApiException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant

/**
 * Foreground service that shares the truck's position during a trip: a GPS fix every ~15 s (or 25 m),
 * queued on the phone and sent in batches, so dead zones on the highway lose nothing.
 */
class TripLocationService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var queue: PointQueue
    private var callback: LocationCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        queue = PointQueue(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopTracking(); return START_NOT_STICKY }
        val trip = TripStore.get(this)
        if (trip == null || !hasLocation(this)) { stopSelf(); return START_NOT_STICKY }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, notification(trip.label), type)
        } catch (e: Exception) {
            // Android refuses a location service started from the background without "Allow all the time".
            stopSelf(); return START_NOT_STICKY
        }
        startUpdates(trip)
        if (uploader == null) uploader = scope.launch { uploadLoop() }
        return START_STICKY
    }

    private var uploader: kotlinx.coroutines.Job? = null

    @SuppressLint("MissingPermission")
    private fun startUpdates(trip: ActiveTrip) {
        if (callback != null) return
        val client = LocationServices.getFusedLocationProviderClient(this)
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 15_000L)
            .setMinUpdateIntervalMillis(10_000L)
            .setMinUpdateDistanceMeters(25f)
            .setWaitForAccurateLocation(false)
            .build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val t = TripStore.get(this@TripLocationService) ?: return
                for (l in result.locations) {
                    if (l.hasAccuracy() && l.accuracy > 100f) continue // skip very rough fixes
                    queue.add(PointQueue.point(t.challanId, t.vehicleId, l.latitude, l.longitude,
                        if (l.hasSpeed()) l.speed else null, if (l.hasBearing()) l.bearing else null, Instant.ofEpochMilli(l.time).toString()))
                }
            }
        }
        callback = cb
        client.requestLocationUpdates(req, cb, Looper.getMainLooper())
    }

    /** Sends queued points (grouped by trip, 500 per request) every 20 s; keeps them on failure. */
    private suspend fun uploadLoop() {
        val api = Services.api(this)
        while (scope.isActive) {
            flushOnce(api)
            if (TripStore.get(this) == null && queue.size() == 0) { stopSelf(); return }
            delay(20_000)
        }
    }

    private suspend fun flushOnce(api: com.onrmc.core.Api) {
        while (true) {
            val batch = queue.peek(500)
            if (batch.isEmpty()) return
            val first = batch.first()
            val challan = first["challanId"]?.jsonPrimitive?.contentOrNull
            val vehicle = first["vehicleId"]?.jsonPrimitive?.contentOrNull ?: run { queue.drop(1); continue }
            val same = batch.takeWhile { it["challanId"]?.jsonPrimitive?.contentOrNull == challan && it["vehicleId"]?.jsonPrimitive?.contentOrNull == vehicle }
            val points = JsonArray(same.map { p -> JsonObject(p.filterKeys { it != "challanId" && it != "vehicleId" }) })
            val body = JsonObject(buildMap {
                put("vehicleId", JsonPrimitive(vehicle)); challan?.let { put("challanId", JsonPrimitive(it)) }; put("points", points)
            })
            try {
                api.post("/gps/points", body)
                queue.drop(same.size)
            } catch (e: ApiException) {
                when {
                    e.status == 401 -> { stopTracking(); return } // signed out
                    e.status in 400..499 && e.status != 402 && e.status != 429 -> queue.drop(same.size) // rejected for good (e.g. truck removed)
                    else -> return // offline or server busy: retry next round
                }
            }
        }
    }

    private fun stopTracking() {
        callback?.let { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(it) }
        callback = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        callback?.let { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(it) }
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(label: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_trip), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Trip in progress")
            .setContentText("Sharing truck location with dispatch · $label")
            .setOngoing(true)
            .setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val CHANNEL = "trip"
        private const val NOTIF_ID = 42
        const val ACTION_STOP = "com.onrmc.driver.STOP"

        fun hasLocation(ctx: Context) = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        fun hasBackground(ctx: Context) = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

        fun start(ctx: Context, trip: ActiveTrip) {
            TripStore.set(ctx, trip)
            ContextCompat.startForegroundService(ctx, Intent(ctx, TripLocationService::class.java))
        }

        /** Ends the trip; the service sends what is still queued, then stops. */
        fun finish(ctx: Context) {
            TripStore.set(ctx, null)
            ctx.startService(Intent(ctx, TripLocationService::class.java).setAction(ACTION_STOP))
            // Flush anything left without holding a foreground notification.
            CoroutineScope(Dispatchers.IO).launch { runCatching { flushRemaining(ctx) } }
        }

        private suspend fun flushRemaining(ctx: Context) {
            val q = PointQueue(ctx)
            val api = Services.api(ctx)
            repeat(20) {
                val batch = q.peek(500)
                if (batch.isEmpty()) return
                val first = batch.first()
                val challan = first["challanId"]?.jsonPrimitive?.contentOrNull
                val vehicle = first["vehicleId"]?.jsonPrimitive?.contentOrNull ?: return
                val same = batch.takeWhile { it["challanId"]?.jsonPrimitive?.contentOrNull == challan }
                val body = JsonObject(buildMap {
                    put("vehicleId", JsonPrimitive(vehicle)); challan?.let { put("challanId", JsonPrimitive(it)) }
                    put("points", JsonArray(same.map { p -> JsonObject(p.filterKeys { k -> k != "challanId" && k != "vehicleId" }) }))
                })
                try { api.post("/gps/points", body); q.drop(same.size) } catch (e: ApiException) { if (e.status == 0) return else q.drop(same.size) }
            }
        }
    }
}
