package com.akhonpay.forwarder

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Server URL / API key / secret, stored encrypted on the device. */
object Config {
    private fun prefs(c: Context) = EncryptedSharedPreferences.create(
        c.applicationContext, "cfg",
        MasterKey.Builder(c.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun get(c: Context, k: String): String = try { prefs(c).getString(k, "") ?: "" } catch (e: Exception) { "" }
    fun set(c: Context, k: String, v: String) = prefs(c).edit().putString(k, v.trim()).apply()
    fun isConfigured(c: Context) = get(c, "url").startsWith("https://") && get(c, "key").isNotEmpty() && get(c, "secret").isNotEmpty()
}
