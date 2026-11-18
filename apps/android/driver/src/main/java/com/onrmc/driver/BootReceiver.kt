package com.onrmc.driver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Resumes trip tracking after a reboot or app update, if a trip was active. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val trip = TripStore.get(context) ?: return
        if (!TripLocationService.hasLocation(context) || !TripLocationService.hasBackground(context)) return
        runCatching { TripLocationService.start(context, trip) }
    }
}
