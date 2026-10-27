package com.akhonpay.forwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return

        // Long SMS arrive in several parts: group by the TRUE originating address (carrier metadata).
        parts.groupBy { it.originatingAddress }.forEach { (address, msgs) ->
            val provider = SmsParser.providerFor(address) ?: return@forEach   // anything not from bKash/Nagad/Rocket is ignored
            val body = msgs.joinToString("") { it.messageBody ?: "" }
            val sms = SmsParser.parse(provider, body) ?: return@forEach

            val payload = JSONObject()
                .put("sender_id", address)
                .put("amount", sms.amount)
                .put("sender_number", sms.sender ?: JSONObject.NULL)
                .put("trx_id", sms.trxId)
                .put("sms_ts", msgs.first().timestampMillis)
                .toString()

            ActivityLog.add(context, "• ${sms.provider} Tk ${sms.amount} ${sms.trxId} queued")
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf("payload" to payload, "trx" to sms.trxId))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // KEEP => the same TrxID is never queued twice.
            WorkManager.getInstance(context).enqueueUniqueWork("trx-${sms.trxId}", ExistingWorkPolicy.KEEP, req)
        }
    }
}
