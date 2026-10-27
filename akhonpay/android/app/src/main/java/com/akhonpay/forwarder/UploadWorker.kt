package com.akhonpay.forwarder

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.IOException

class UploadWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val body = inputData.getString("payload") ?: return Result.failure()
        val trx = inputData.getString("trx") ?: "?"
        val c = applicationContext
        return try {
            val code = Http.postCallback(Config.get(c, "url"), Config.get(c, "key"), Config.get(c, "secret"), body)
            when (code) {
                in 200..299 -> { ActivityLog.add(c, "✓ $trx uploaded"); ActivityLog.setLastUpload(c, true, "$trx uploaded"); Result.success() }
                in 400..499 -> { ActivityLog.add(c, "✗ $trx rejected (HTTP $code)"); ActivityLog.setLastUpload(c, false, "HTTP $code"); Result.failure() }
                else -> { ActivityLog.add(c, "… $trx server error $code, will retry"); Result.retry() }
            }
        } catch (e: IOException) {
            ActivityLog.add(c, "… $trx network error, will retry"); Result.retry()
        }
    }
}
