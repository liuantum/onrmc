package com.onrmc.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Error with a message that can be shown to the user as-is. */
class ApiException(val status: Int, message: String, val code: String? = null) : Exception(message) {
    val unauthorized get() = status == 401
}

/** Small JSON client for the onrmc API. Every call runs on the IO dispatcher. */
class Api(private val session: Session) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun get(path: String): JsonElement = send("GET", path, null)
    suspend fun post(path: String, body: JsonElement = JsonObject(emptyMap())): JsonElement = send("POST", path, body)

    private suspend fun send(method: String, path: String, body: JsonElement?): JsonElement = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(session.apiUrl + path)
            .header("Accept", "application/json")
            .apply { session.token?.let { header("Authorization", "Bearer $it") } }
            .method(method, body?.toString()?.toRequestBody(jsonType))
            .build()
        val res = try { http.newCall(req).execute() } catch (e: IOException) {
            throw ApiException(0, "Can't reach the onrmc server at ${session.apiUrl}. Check your internet connection.")
        }
        res.use {
            val text = it.body?.string().orEmpty()
            val parsed = runCatching { if (text.isBlank()) JsonNull else Json.parseToJsonElement(text) }.getOrDefault(JsonNull)
            if (!it.isSuccessful) {
                val o = parsed as? JsonObject
                val issues = (o?.get("issues") as? JsonArray)?.joinToString(", ") { i -> i.jsonObject.str("message") }
                val msg = issues?.takeIf { s -> s.isNotBlank() } ?: o?.str("error")?.takeIf { s -> s.isNotBlank() } ?: "Server error (${it.code})"
                if (it.code == 401) session.clear()
                throw ApiException(it.code, msg, o?.str("code"))
            }
            parsed
        }
    }

    /** Signs in and stores the token. Returns the login response (token, user, subscription). */
    suspend fun login(phone: String, password: String): JsonObject {
        val r = post("/auth/login", obj("phone" to phone.trim(), "password" to password)).jsonObject
        session.token = r.str("token")
        session.user = r["user"] as? JsonObject
        return r
    }
}

// ───── JSON helpers: Prisma decimals arrive as strings, so numbers are read leniently ─────
fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to v.toJson() })
private fun Any?.toJson(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (k, v) -> k.toString() to v.toJson() })
    is List<*> -> JsonArray(map { it.toJson() })
    else -> JsonPrimitive(toString())
}

fun JsonObject.o(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.arr(key: String): List<JsonObject> = (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
fun JsonObject.str(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull ?: ""
fun JsonObject.strOrNull(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
fun JsonObject.num(key: String): Double = (this[key] as? JsonPrimitive)?.let { it.doubleOrNull ?: it.contentOrNull?.toDoubleOrNull() } ?: 0.0
fun JsonObject.numOrNull(key: String): Double? = (this[key] as? JsonPrimitive)?.let { it.doubleOrNull ?: it.contentOrNull?.toDoubleOrNull() }
fun JsonElement.list(): List<JsonObject> = (this as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
