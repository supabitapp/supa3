package expo.modules.supacoderelaytunnel.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.assertEquals
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.json.JSONObject
import org.junit.Test

class NativeTunnelTest {
  private val vector = JSONObject(File("fixtures/vectors.json").readText())

  private class SilentHost(private val identity: ByteArray) : WebSocketListener() {
    private val secret = ByteArray(32) { (it + 64).toByte() }
    private var cipher: RelayCipher? = null
    val records = LinkedBlockingQueue<ByteArray>()

    private fun hmac(key: ByteArray, bytes: ByteArray) =
      Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(bytes)
      }

    override fun onMessage(webSocket: WebSocket, text: String) {
      val client = unb64(JSONObject(text).getString("key"))
      val key = X25519.publicFromPrivate(secret)
      val transcript = "supacode-tunnel-v2\n".toByteArray() + identity + client + key
      val prk = hmac(sha256(transcript), X25519.computeSharedSecret(secret, client))
      val info = "supacode-tunnel-traffic-v1".toByteArray()
      val clientKey = hmac(prk, info + byteArrayOf(1))
      cipher = RelayCipher(hmac(prk, clientKey + info + byteArrayOf(2)), clientKey)
      val signature = Ed25519Sign(ByteArray(32) { it.toByte() }).sign(transcript)
      webSocket.send(
        JSONObject()
          .put("type", "welcome")
          .put("version", 2)
          .put("key", b64(key))
          .put("signature", b64(signature))
          .toString()
      )
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      cipher?.let { records.add(it.open(bytes.toByteArray())) }
    }
  }

  @Test
  fun idleSessionPingsThenClosesAfterThreeMissedTicks() {
    val host = SilentHost(unhex(vector.getString("identity")))
    MockWebServer().use { server ->
      server.enqueue(MockResponse().withWebSocketUpgrade(host))
      val down = CompletableFuture<Map<String, Any>>()
      NativeTunnel(
        server.url("/").toString().replaceFirst("http", "ws"),
        vector.getString("address"),
        onStatus = { if (it["reason"] == "Relay session timed out") down.complete(it) },
        keepaliveMillis = 50,
      ).use {
        assertEquals(TunnelMux.frame(6, 0).hex(), host.records.poll(10, TimeUnit.SECONDS)?.hex())
        assertEquals("down", down.get(10, TimeUnit.SECONDS)["state"])
      }
    }
  }
}
