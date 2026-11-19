package com.onrmc.core

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Shared sign-in screen. [allowedRoles] keeps each app to its users (e.g. only drivers in the driver app).
 * The server address can be changed here, so one build works against any onrmc server.
 */
@Composable
fun LoginScreen(appName: String, session: Session, api: Api, allowedRoles: Set<String>, onSignedIn: (JsonObject) -> Unit) {
    var phone by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var server by remember { mutableStateOf(session.apiUrl) }
    var showServer by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun submit() {
        if (busy) return
        error = null; busy = true
        scope.launch {
            try {
                session.apiUrl = server
                server = session.apiUrl
                val r = api.login(phone, password)
                val role = r.o("user")?.str("role").orEmpty()
                if (role !in allowedRoles) {
                    session.clear()
                    error = "This app is for ${allowedRoles.joinToString(" / ") { it.lowercase() }} logins. Your account is ${role.lowercase()}."
                } else onSignedIn(r)
            } catch (e: ApiException) {
                error = e.message
            } finally { busy = false }
        }
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).systemBarsPadding().imePadding()) {
        Column(
            Modifier.fillMaxWidth().align(Alignment.Center).verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("onrmc", fontSize = 40.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.primary)
            Text(appName, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 16.sp)
            OutlinedTextField(
                phone, { phone = it.filter { c -> c.isDigit() }.take(10) }, label = { Text("Mobile number") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                password, { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done), modifier = Modifier.fillMaxWidth(),
            )
            if (showServer) OutlinedTextField(
                server, { server = it }, label = { Text("Server address") }, singleLine = true, supportingText = { Text("e.g. https://api.onrmc.in or 192.168.1.20 on Wi-Fi") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth(),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = ::submit, enabled = phone.length >= 10 && password.isNotEmpty() && !busy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp) else Text("Sign in", fontSize = 16.sp)
            }
            TextButton(onClick = { showServer = !showServer }) { Text(if (showServer) "Hide server address" else "Server: ${session.apiUrl.removeSuffix("/api")}", fontSize = 12.sp) }
            Spacer(Modifier.height(24.dp))
            Text(BRAND_CREDIT, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
