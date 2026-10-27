package com.akhonpay.forwarder

import java.net.HttpURLConnection
import java.net.URL
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Http {
    fun hmacHex(secret: String, msg: String): String {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256")) }
        return mac.doFinal(msg.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** POST a signed payload to /api/v1/mfs-callback. Returns the HTTP status code. */
    fun postCallback(base: String, key: String, secret: String, body: String): Int {
        val ts = System.currentTimeMillis().toString()
        val c = URL(base.trimEnd('/') + "/api/v1/mfs-callback").openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.connectTimeout = 10_000; c.readTimeout = 15_000; c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("X-API-KEY", key)
            c.setRequestProperty("X-Timestamp", ts)
            c.setRequestProperty("X-Signature", hmacHex(secret, "$ts.$body"))
            c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            return c.responseCode
        } finally { c.disconnect() }
    }
}
