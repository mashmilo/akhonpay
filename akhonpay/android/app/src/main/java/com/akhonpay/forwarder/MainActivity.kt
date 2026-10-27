package com.akhonpay.forwarder

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private val ok by lazy { ContextCompat.getColor(this, R.color.status_ok) }
    private val bad by lazy { ContextCompat.getColor(this, R.color.status_bad) }
    private val idle by lazy { ContextCompat.getColor(this, R.color.status_idle) }

    private val askSms = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) Toast.makeText(this, R.string.perm_denied_hint, Toast.LENGTH_LONG).show()
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val root = findViewById<View>(R.id.rootScroll)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(v.paddingLeft, b.top + 16, v.paddingRight, b.bottom + 16); insets
        }

        findViewById<TextView>(R.id.tvVersion).text = getString(R.string.tagline) + "  •  v" + BuildConfig.VERSION_NAME
        field(R.id.etUrl).setText(Config.get(this, "url"))
        field(R.id.etKey).setText(Config.get(this, "key"))
        field(R.id.etSecret).setText(Config.get(this, "secret"))

        findViewById<Button>(R.id.btnSave).setOnClickListener { save() }
        findViewById<Button>(R.id.btnTestServer).setOnClickListener { testServer() }
        findViewById<Button>(R.id.btnPermission).setOnClickListener { askSms.launch(Manifest.permission.RECEIVE_SMS) }
        findViewById<Button>(R.id.btnBattery).setOnClickListener { requestBattery() }
        findViewById<Button>(R.id.btnParse).setOnClickListener { parseSample() }
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun field(id: Int) = findViewById<EditText>(id)

    private fun save(): Boolean {
        val url = field(R.id.etUrl).text.toString().trim()
        val key = field(R.id.etKey).text.toString().trim()
        val secret = field(R.id.etSecret).text.toString().trim()
        if (url.isEmpty() || key.isEmpty() || secret.isEmpty()) { toast(R.string.fill_all); return false }
        if (!url.startsWith("https://")) { toast(R.string.url_https); return false }
        Config.set(this, "url", url); Config.set(this, "key", key); Config.set(this, "secret", secret)
        toast(R.string.saved); refresh(); return true
    }

    /**
     * Sends a correctly signed request with a fake sender id. A healthy server answers
     * 422 unknown_sender: that proves URL, API key, secret and clock are all right,
     * and nothing is written to the ledger.
     */
    private fun testServer() {
        if (!save()) return
        val tv = findViewById<TextView>(R.id.tvServerStatus)
        tv.text = "Testing…"
        thread {
            val msg = try {
                val body = JSONObject().put("sender_id", "AKHONPAY-TEST").put("amount", "1").put("trx_id", "TEST000000").toString()
                when (val code = Http.postCallback(Config.get(this, "url"), Config.get(this, "key"), Config.get(this, "secret"), body)) {
                    422 -> "OK" to true
                    401 -> "Wrong key/secret or phone clock off" to false
                    else -> "Unexpected HTTP $code" to false
                }
            } catch (e: Exception) { "Cannot reach server" to false }
            runOnUiThread {
                tv.text = msg.first
                setDot(R.id.dotServer, if (msg.second) ok else bad)
                ActivityLog.add(this, "Server test: ${msg.first}")
                refresh(keepServerText = true)
            }
        }
    }

    private fun parseSample() {
        val sender = field(R.id.etSender).text.toString()
        val body = field(R.id.etSample).text.toString()
        val out = findViewById<TextView>(R.id.tvParseResult)
        out.visibility = View.VISIBLE
        val provider = SmsParser.providerFor(sender)
        out.text = when {
            provider == null -> "Sender \"$sender\" is not a known bKash/Nagad/Rocket ID → would be IGNORED."
            else -> SmsParser.parse(provider, body)?.let {
                "provider: ${it.provider}\namount:   ${it.amount}\nsender:   ${it.sender ?: "-"}\ntrx_id:   ${it.trxId}"
            } ?: "Sender OK, but no payment-received pattern found → would be IGNORED."
        }
    }

    private fun requestBattery() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
    }

    private fun refresh(keepServerText: Boolean = false) {
        val smsOk = ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        findViewById<TextView>(R.id.tvSmsStatus).setText(if (smsOk) R.string.state_granted else R.string.state_denied)
        setDot(R.id.dotSms, if (smsOk) ok else bad)
        findViewById<View>(R.id.tvRestrictedHelp).visibility = if (smsOk || Build.VERSION.SDK_INT < 33) View.GONE else View.VISIBLE

        val unrestricted = (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)
        findViewById<TextView>(R.id.tvBatteryStatus).setText(if (unrestricted) R.string.state_unrestricted else R.string.state_restricted)
        setDot(R.id.dotBattery, if (unrestricted) ok else idle)

        if (!keepServerText) {
            val last = ActivityLog.lastOk(this)
            findViewById<TextView>(R.id.tvServerStatus).text = if (last == null) getString(R.string.state_never) else ActivityLog.lastDetail(this)
            setDot(R.id.dotServer, when (last) { true -> ok; false -> bad; null -> idle })
        }
        val log = ActivityLog.text(this)
        findViewById<TextView>(R.id.tvLog).text = if (log.isBlank()) getString(R.string.log_empty) else log
    }

    private fun setDot(id: Int, color: Int) { findViewById<View>(id).backgroundTintList = android.content.res.ColorStateList.valueOf(color) }
    private fun toast(r: Int) = Toast.makeText(this, r, Toast.LENGTH_SHORT).show()
}
