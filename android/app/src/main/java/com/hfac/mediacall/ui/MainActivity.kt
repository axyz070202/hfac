package com.hfac.mediacall.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.hfac.mediacall.R
import com.hfac.mediacall.util.Prefs
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var serverUrl: EditText
    private lateinit var displayName: EditText
    private lateinit var joinCode: EditText
    private lateinit var hifiMode: CheckBox

    /** Action deferred until RECORD_AUDIO is granted. */
    private var pendingLaunch: (() -> Unit)? = null

    private val micPermission =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.RECORD_AUDIO] == true) {
                pendingLaunch?.invoke()
            } else {
                Toast.makeText(this, R.string.mic_permission_needed, Toast.LENGTH_LONG).show()
            }
            pendingLaunch = null
        }

    private val qrScanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { raw ->
            val code = extractCode(raw)
            if (code != null) {
                joinCode.setText(code)
                launchCall { CallIntent.join(it, code) }
            } else {
                Toast.makeText(this, "No room code in QR", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        serverUrl = findViewById(R.id.serverUrl)
        displayName = findViewById(R.id.displayName)
        joinCode = findViewById(R.id.joinCode)
        hifiMode = findViewById(R.id.hifiMode)

        serverUrl.setText(prefs.serverUrl)
        displayName.setText(prefs.displayName)
        hifiMode.isChecked = prefs.hiFi

        findViewById<Button>(R.id.btnCreateDuo).setOnClickListener {
            launchCall { CallIntent.create(it, "duo") }
        }
        findViewById<Button>(R.id.btnCreateGroup).setOnClickListener {
            launchCall { CallIntent.create(it, "group") }
        }
        findViewById<Button>(R.id.btnJoin).setOnClickListener {
            val code = joinCode.text.toString().filter { it.isDigit() }
            if (code.length != 8) {
                Toast.makeText(this, R.string.join_code_hint, Toast.LENGTH_SHORT).show()
            } else {
                launchCall { CallIntent.join(it, code) }
            }
        }
        findViewById<Button>(R.id.btnScan).setOnClickListener {
            qrScanner.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt("Scan a MediaCall room QR")
                    .setBeepEnabled(false)
            )
        }

        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    /** mediacall://join/12345678 (from links or the server's landing page). */
    private fun handleDeepLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme == "mediacall" && data.host == "join") {
            val code = extractCode(data.toString()) ?: return
            joinCode.setText(code)
            launchCall { CallIntent.join(it, code) }
        }
    }

    private fun launchCall(build: (CallIntent.Base) -> Intent) {
        val server = serverUrl.text.toString().trim()
        val name = displayName.text.toString().trim().ifEmpty { "Guest" }
        if (server.isEmpty()) {
            Toast.makeText(this, R.string.server_url_hint, Toast.LENGTH_SHORT).show()
            return
        }
        prefs.serverUrl = server
        prefs.displayName = name
        prefs.hiFi = hifiMode.isChecked

        val base = CallIntent.Base(this, server, name, hifiMode.isChecked)
        val go = { startActivity(build(base)) }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            go()
        } else {
            pendingLaunch = go
            micPermission.launch(
                arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
            )
        }
    }

    companion object {
        /** Pulls an 8-digit room code out of a scanned/pasted string. */
        fun extractCode(raw: String): String? =
            Regex("(?<!\\d)(\\d{8})(?!\\d)").find(raw)?.groupValues?.get(1)
    }
}
