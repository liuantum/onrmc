package com.onrmc.core

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Brand = Color(0xFF1D4ED8)
val BrandDark = Color(0xFF172554)
val Good = Color(0xFF059669)
val Warn = Color(0xFFD97706)
val Bad = Color(0xFFDC2626)

private val Light = lightColorScheme(
    primary = Brand, onPrimary = Color.White, primaryContainer = Color(0xFFD9EAFF), onPrimaryContainer = BrandDark,
    background = Color(0xFFF8FAFC), surface = Color.White, surfaceVariant = Color(0xFFF1F5F9),
    onSurfaceVariant = Color(0xFF64748B), outline = Color(0xFFCBD5E1), outlineVariant = Color(0xFFE2E8F0), error = Bad,
)
private val Dark = darkColorScheme(
    primary = Color(0xFF93B4FF), onPrimary = BrandDark, primaryContainer = Color(0xFF1E3A8A), onPrimaryContainer = Color(0xFFD9EAFF),
    background = Color(0xFF0B1120), surface = Color(0xFF111827), surfaceVariant = Color(0xFF1F2937),
    onSurfaceVariant = Color(0xFF9CA3AF), outline = Color(0xFF374151), outlineVariant = Color(0xFF1F2937), error = Color(0xFFF87171),
)

@Composable
fun OnrmcTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
