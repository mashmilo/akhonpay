package com.akhonpay.forwarder

data class ParsedSms(val provider: String, val amount: String, val sender: String?, val trxId: String)

object SmsParser {
    // Matched (case-insensitively, exact) against the message's OriginatingAddress, NEVER the body.
    // Confirm the short codes against the sender IDs you actually see on your phone.
    private val SENDERS = mapOf(
        "bkash" to setOf("bkash", "16247"),
        "nagad" to setOf("nagad", "16167"),
        "rocket" to setOf("rocket", "16216"),
    )

    private val RECEIVED = Regex("""(?i)\breceived\b""")
    private val AMOUNT = Regex("""(?i)(?:tk\.?|bdt|৳)\s*:?\s*([\d,]+(?:\.\d{1,2})?)""")
    private val TRX = Regex("""(?i)\b(?:trx\s?id|txn\s?id|transaction\s?id)\s*[:\-]?\s*([A-Z0-9]{6,20})\b""")
    private val SENDER_NO = Regex("""(?<!\d)(?:\+?88)?(01[3-9]\d{8})(?!\d)""")
    private val NOT_PAYMENT_AMOUNT = Regex("""(?i)(fee|balance|charge|commission)\s*:?\s*$""")

    fun providerFor(originatingAddress: String?): String? {
        val a = originatingAddress?.trim()?.lowercase() ?: return null
        return SENDERS.entries.firstOrNull { a in it.value }?.key
    }

    fun parse(provider: String, body: String): ParsedSms? {
        if (!RECEIVED.containsMatchIn(body)) return null   // ignore cash-out, payments, bill pay, etc.
        // First amount that is not labelled Fee / Balance / Charge.
        val amount = AMOUNT.findAll(body).firstOrNull { m ->
            !NOT_PAYMENT_AMOUNT.containsMatchIn(body.substring(maxOf(0, m.range.first - 14), m.range.first))
        }?.groupValues?.get(1)?.replace(",", "") ?: return null
        val trx = TRX.find(body)?.groupValues?.get(1)?.uppercase() ?: return null
        val sender = SENDER_NO.find(body)?.groupValues?.get(1)
        return ParsedSms(provider, amount, sender, trx)
    }
}
