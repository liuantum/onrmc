package com.onrmc.core

import java.text.NumberFormat
import java.util.Locale

private val india = Locale.Builder().setLanguage("en").setRegion("IN").build()

/** ₹1,23,456 (Indian grouping, no paise for large numbers). */
fun inr(n: Double): String {
    val f = NumberFormat.getCurrencyInstance(india)
    f.maximumFractionDigits = if (kotlin.math.abs(n) >= 1000) 0 else 2
    return f.format(n)
}

fun qty(n: Double, digits: Int = 2): String {
    val f = NumberFormat.getNumberInstance(india)
    f.maximumFractionDigits = digits
    return f.format(n)
}

/** "IN_TRANSIT" → "In transit" */
fun pretty(status: String): String = status.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
