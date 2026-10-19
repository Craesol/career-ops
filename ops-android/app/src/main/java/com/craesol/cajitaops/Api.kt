package com.craesol.cajitaops

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Client for CAJITA's ops-api. Trusts exactly ONE certificate — the server's
 * self-signed cert, bundled at build time — and nothing else: a public CA cert,
 * a proxy, or another host is rejected. The hostname check compares the peer
 * certificate itself, so the same pinned cert works by LAN IP, public IP or a
 * DDNS name.
 */
class Api(context: Context, private val baseUrl: String, private val token: String) {

    private val pinned: X509Certificate = context.resources.openRawResource(R.raw.ops_cert).use {
        CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
    }

    private val client: OkHttpClient = run {
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("cajita-ops", pinned)
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
        OkHttpClient.Builder()
            .sslSocketFactory(ssl.socketFactory, tm)
            .hostnameVerifier { _, session -> session.peerCertificates.firstOrNull() == pinned }
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(40, TimeUnit.SECONDS)
            .build()
    }

    class ApiError(message: String) : Exception(message)

    private fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val req = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $token")
            .apply {
                if (method == "POST") post((body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
            }
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrElse { JSONObject().put("error", text.take(200)) }
            if (!resp.isSuccessful) throw ApiError(json.optString("error", "HTTP ${resp.code}"))
            return json
        }
    }

    fun status() = call("GET", "/v1/status")
    fun finds(days: Int = 2) = call("GET", "/v1/finds?days=$days")
    fun tracker(status: String?) = call("GET", "/v1/tracker" + (status?.let { "?status=$it" } ?: ""))
    fun logs(name: String, lines: Int = 120) = call("GET", "/v1/logs/$name?lines=$lines")
    fun jobs() = call("GET", "/v1/jobs")

    fun runScan() = call("POST", "/v1/actions/scan")
    fun restartWeb() = call("POST", "/v1/actions/restart-web")
    fun createCv(url: String, title: String, company: String) =
        call("POST", "/v1/actions/create-cv", JSONObject().put("url", url).put("title", title).put("company", company))
    fun dismiss(url: String, title: String, company: String) =
        call("POST", "/v1/actions/dismiss", JSONObject().put("url", url).put("title", title).put("company", company))
    fun setStatus(row: Int, status: String, note: String?) =
        call("POST", "/v1/actions/set-status", JSONObject().put("row", row).put("status", status).apply { if (!note.isNullOrBlank()) put("note", note) })
}
