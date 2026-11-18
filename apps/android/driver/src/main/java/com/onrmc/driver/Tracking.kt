package com.onrmc.driver

import android.content.Context
import com.onrmc.core.Api
import com.onrmc.core.Session
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.io.File

/** One Session/Api per process, shared by the screen and the background service. */
object Services {
    @Volatile private var s: Session? = null
    @Volatile private var a: Api? = null
    fun session(ctx: Context): Session = s ?: synchronized(this) { s ?: Session(ctx).also { s = it } }
    fun api(ctx: Context): Api = a ?: synchronized(this) { a ?: Api(session(ctx)).also { a = it } }
}

/** The trip being tracked right now (survives app restarts and phone reboots). */
data class ActiveTrip(val challanId: String, val vehicleId: String, val label: String)

object TripStore {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("onrmc.trip", Context.MODE_PRIVATE)
    fun get(ctx: Context): ActiveTrip? {
        val p = prefs(ctx)
        val c = p.getString("challanId", null) ?: return null
        return ActiveTrip(c, p.getString("vehicleId", "")!!, p.getString("label", "")!!)
    }
    fun set(ctx: Context, t: ActiveTrip?) {
        val e = prefs(ctx).edit()
        if (t == null) e.clear() else e.putString("challanId", t.challanId).putString("vehicleId", t.vehicleId).putString("label", t.label)
        e.apply()
    }
}

/**
 * GPS points waiting to be sent, one JSON object per line in app storage, so nothing is lost when the
 * network drops or the app is killed. Capped at [MAX] points (oldest dropped first).
 */
class PointQueue(ctx: Context) {
    private val file = File(ctx.filesDir, "gps-queue.jsonl")
    private val lock = Any()

    fun add(point: JsonObject) = synchronized(lock) {
        file.appendText(point.toString() + "\n")
        val lines = file.readLines()
        if (lines.size > MAX) file.writeText(lines.takeLast(MAX).joinToString("\n", postfix = "\n"))
    }

    /** Oldest points first, at most [n], each with the trip it belongs to. */
    fun peek(n: Int): List<JsonObject> = synchronized(lock) {
        if (!file.exists()) return emptyList()
        file.useLines { seq -> seq.filter { it.isNotBlank() }.take(n).mapNotNull { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() }.toList() }
    }

    fun drop(n: Int) = synchronized(lock) {
        if (!file.exists()) return
        val rest = file.readLines().filter { it.isNotBlank() }.drop(n)
        file.writeText(if (rest.isEmpty()) "" else rest.joinToString("\n", postfix = "\n"))
    }

    fun size(): Int = synchronized(lock) { if (file.exists()) file.readLines().count { it.isNotBlank() } else 0 }

    companion object {
        const val MAX = 20_000
        fun point(challanId: String, vehicleId: String, lat: Double, lng: Double, speed: Float?, heading: Float?, at: String) = JsonObject(buildMap {
            put("challanId", JsonPrimitive(challanId)); put("vehicleId", JsonPrimitive(vehicleId))
            put("lat", JsonPrimitive(lat)); put("lng", JsonPrimitive(lng)); put("at", JsonPrimitive(at))
            speed?.let { put("speed", JsonPrimitive(it)) }; heading?.let { put("heading", JsonPrimitive(it)) }
        })
    }
}
