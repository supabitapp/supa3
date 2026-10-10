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
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import org.junit.Test

class NativeTunnelTest {
  private val vector = JSONObject(File("fixtures/vectors.json").readText())

  private class SilentHost(
    private val identity: ByteArray,
    private val replyToPings: Boolean = false
  ) : WebSocketListener() {
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
      cipher?.let {
        val record = it.open(bytes.toByteArray())
        records.add(record)
        if (replyToPings && record.firstOrNull() == 6.toByte()) {
          webSocket.send(it.seal(TunnelMux.frame(7, 0)).toByteString())
        }
      }
    }
  }

  @Test
  fun foregroundCancelsBackgroundCloseAndKeepsResponsiveSession() {
    val host = SilentHost(unhex(vector.getString("identity")), replyToPings = true)
    MockWebServer().use { server ->
      server.enqueue(MockResponse().withWebSocketUpgrade(host))
      val connected = CompletableFuture<Map<String, Any>>()
      val down = CompletableFuture<Map<String, Any>>()
      NativeTunnel(
        server.url("/").toString().replaceFirst("http", "ws"),
        vector.getString("address"),
        onStatus = {
          if (it["state"] == "up") {
            connected.complete(it)
          }
          if (it["reason"] != null) down.complete(it)
        },
      ).use { tunnel ->
        connected.get(10, TimeUnit.SECONDS)
        tunnel.background(100)
        tunnel.resume(300)
        assertEquals(TunnelMux.frame(6, 0).hex(), host.records.poll(10, TimeUnit.SECONDS)?.hex())
        assertFailsWith<java.util.concurrent.TimeoutException> {
          down.get(600, TimeUnit.MILLISECONDS)
        }
        assertEquals(1, server.requestCount)
        assertEquals(1, connected.get()["sessionCount"])
      }
    }
  }

  @Test
  fun backgroundGraceClosesTheSessionAndForegroundReconnects() {
    MockWebServer().use { server ->
      repeat(2) {
        server.enqueue(
          MockResponse().withWebSocketUpgrade(SilentHost(unhex(vector.getString("identity"))))
        )
      }
      val connected = CompletableFuture<Unit>()
      val down = CompletableFuture<Unit>()
      val reconnected = CompletableFuture<Unit>()
      NativeTunnel(
        server.url("/").toString().replaceFirst("http", "ws"),
        vector.getString("address"),
        onStatus = {
          if (it["state"] == "up") {
            connected.complete(Unit)
            if (it["sessionCount"] == 2) {
              reconnected.complete(Unit)
            }
          }
          if (it["reason"] == "Backgrounded") down.complete(Unit)
        },
      ).use { tunnel ->
        connected.get(10, TimeUnit.SECONDS)
        tunnel.background(100)
        down.get(10, TimeUnit.SECONDS)
        assertLoopbackClosed(tunnel.origin)
        assertEquals(1, server.requestCount)
        tunnel.resume()
        reconnected.get(10, TimeUnit.SECONDS)
      }
    }
  }

  private fun assertLoopbackClosed(value: String) {
    val origin = java.net.URI(value)
    java.net.Socket(origin.host, origin.port).use { socket ->
      socket.soTimeout = 5_000
      socket.getOutputStream().write(
        "GET / HTTP/1.1\r\nHost: ${origin.host}:${origin.port}\r\n\r\n".toByteArray()
      )
      val closed = try {
        socket.getInputStream().read() == -1
      } catch (_: java.net.SocketException) {
        true
      }
      assertTrue(closed)
    }
  }

  @Test
  fun foregroundProbeReplacesASilentSessionBeforeKeepaliveExpiry() {
    MockWebServer().use { server ->
      repeat(2) {
        server.enqueue(
          MockResponse().withWebSocketUpgrade(SilentHost(unhex(vector.getString("identity"))))
        )
      }
      val connected = CompletableFuture<Unit>()
      val failed = CompletableFuture<Unit>()
      val reconnected = CompletableFuture<Unit>()
      NativeTunnel(
        server.url("/").toString().replaceFirst("http", "ws"),
        vector.getString("address"),
        onStatus = {
          if (it["state"] == "up") {
            connected.complete(Unit)
            if (it["sessionCount"] == 2) {
              reconnected.complete(Unit)
            }
          }
          if (it["reason"] == "Relay resume probe timed out") failed.complete(Unit)
        },
      ).use { tunnel ->
        connected.get(10, TimeUnit.SECONDS)
        tunnel.resume(100)
        failed.get(10, TimeUnit.SECONDS)
        reconnected.get(10, TimeUnit.SECONDS)
        assertEquals(2, server.requestCount)
      }
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
