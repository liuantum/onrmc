package com.onrmc.core

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Server address, sign-in token and user, kept in the app's private storage. */
class Session(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences("onrmc.session", Context.MODE_PRIVATE)

    var apiUrl: String
        get() = prefs.getString("apiUrl", null) ?: BuildConfig.DEFAULT_API_URL
        set(v) = prefs.edit().putString("apiUrl", normaliseApiUrl(v)).apply()

    var token: String?
        get() = prefs.getString("token", null)
        set(v) = prefs.edit().putString("token", v).apply()

    var user: JsonObject?
        get() = prefs.getString("user", null)?.let { runCatching { Json.parseToJsonElement(it) as JsonObject }.getOrNull() }
        set(v) = prefs.edit().putString("user", v?.toString()).apply()

    val signedIn get() = token != null

    fun clear() = prefs.edit().remove("token").remove("user").apply()

    companion object {
        /**
         * Accepts "192.168.1.5" (→ http://192.168.1.5:4000/api), "api.onrmc.in" (→ https://api.onrmc.in/api),
         * or any full URL, with or without the trailing /api.
         */
        fun normaliseApiUrl(input: String): String {
            var s = input.trim().trimEnd('/')
            if (s.isEmpty()) return BuildConfig.DEFAULT_API_URL
            if (!s.startsWith("http://") && !s.startsWith("https://")) {
                val host = s.substringBefore('/').substringBefore(':')
                val local = host == "localhost" || Regex("""^\d{1,3}(\.\d{1,3}){3}$""").matches(host)
                s = if (local) "http://$s" else "https://$s"
                if (local && !s.substringAfter("://").substringBefore('/').contains(':')) {
                    val rest = s.substringAfter("://")
                    s = "http://" + rest.substringBefore('/') + ":4000" + (if (rest.contains('/')) "/" + rest.substringAfter('/') else "")
                }
            }
            if (!s.endsWith("/api")) s = "$s/api"
            return s
        }
    }
}
