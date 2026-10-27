package com.akhonpay.forwarder

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Tiny rolling log (last 30 lines). Never stores the full SMS text, only trx id + status. */
object ActivityLog {
    private const val MAX = 30
    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences("log", Context.MODE_PRIVATE)

    @Synchronized
    fun add(c: Context, line: String) {
        val ts = SimpleDateFormat("dd MMM HH:mm:ss", Locale.US).format(Date())
        val old = prefs(c).getString("lines", "")!!.split("\n").filter { it.isNotBlank() }
        val all = (listOf("$ts  $line") + old).take(MAX)
        prefs(c).edit().putString("lines", all.joinToString("\n")).apply()
    }

    fun text(c: Context): String = prefs(c).getString("lines", "")!!

    fun setLastUpload(c: Context, ok: Boolean, detail: String) {
        prefs(c).edit().putBoolean("last_ok", ok).putString("last_detail", detail).putLong("last_at", System.currentTimeMillis()).apply()
    }
    fun lastOk(c: Context): Boolean? = if (prefs(c).contains("last_ok")) prefs(c).getBoolean("last_ok", false) else null
    fun lastDetail(c: Context): String = prefs(c).getString("last_detail", "")!!
}
