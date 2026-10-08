package expo.modules.supacoderelaytunnel.core

import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test

class ProtocolTest {
  private fun vector() = JSONObject(File("fixtures/vectors.json").readText())

  @Test
  fun nodeKnownAnswersForPlatformAndFallback() {
    for (fallback in listOf(false, true)) {
      val v = vector()
      val handshake =
        ClientHandshake(
          unhex(v.getString("identity")),
          unhex(v.getString("clientSecret")),
          CurveCrypto(fallback),
        )
      assertEquals(
        JSONObject(v.getString("hello")).getString("key"),
        JSONObject(handshake.hello).getString("key"),
      )
      assertContentEquals(
        unhex(v.getString("identity")),
        parseRelayIdentity(v.getString("address") + "pair#token=unused"),
      )
      val transcript =
        "supacode-tunnel-v2\n".toByteArray() +
          unhex(v.getString("identity")) +
          unb64(JSONObject(handshake.hello).getString("key")) +
          unb64(JSONObject(v.getString("welcome")).getString("key"))
      assertEquals(v.getString("transcript"), transcript.hex())
      val cipher = handshake.finish(v.getString("welcome"))
      val records = v.getJSONArray("records")
      for (index in 0 until records.length()) {
        val record = records.getJSONObject(index)
        assertEquals(
          record.getString("client"),
          cipher.seal(unhex(record.getString("plain"))).hex(),
        )
        assertEquals(record.getString("plain"), cipher.open(unhex(record.getString("host"))).hex())
      }
      assertFails { cipher.open(unhex(records.getJSONObject(0).getString("host"))) }
      cipher.destroy()
      assertFails { cipher.seal(byteArrayOf(1)) }
    }
  }

  @Test
  fun rejectsIdentityVersionAndAuthenticationChanges() {
    val v = vector()
    for (fallback in listOf(false, true)) {
      for (change in listOf("identity", "version", "key", "signature")) {
        val identity = unhex(v.getString("identity"))
        if (change == "identity") identity[0] = (identity[0].toInt() xor 1).toByte()
        val welcome = JSONObject(v.getString("welcome"))
        if (change == "version") welcome.put("version", 1)
        if (change == "key" || change == "signature") {
          val bytes = unb64(welcome.getString(change))
          bytes[0] = (bytes[0].toInt() xor 1).toByte()
          welcome.put(change, b64(bytes))
        }
        assertFails {
          ClientHandshake(identity, unhex(v.getString("clientSecret")), CurveCrypto(fallback))
            .finish(welcome.toString())
        }
      }
      assertFails { CurveCrypto(fallback).shared(ByteArray(32) { 42 }, ByteArray(32)) }
    }
    val cipher =
      ClientHandshake(unhex(v.getString("identity")), unhex(v.getString("clientSecret")))
        .finish(v.getString("welcome"))
    val frame = unhex(v.getJSONArray("records").getJSONObject(0).getString("host"))
    frame[frame.lastIndex] = (frame.last().toInt() xor 1).toByte()
    assertFails { cipher.open(frame) }
    assertFails { cipher.open(ByteArray(65561)) }
  }

  private fun cipher() = RelayCipher(ByteArray(32) { 1 }, ByteArray(32) { 1 })

  private fun frameHeaders(plain: ByteArray): List<Pair<Int, Int>> {
    val buffer = ByteBuffer.wrap(plain)
    val frames = ArrayList<Pair<Int, Int>>()
    while (buffer.hasRemaining()) {
      val type = buffer.get().toInt()
      val id = buffer.int
      val size = buffer.int
      buffer.position(buffer.position() + size)
      frames.add(type to id)
    }
    return frames
  }

  @Test
  fun sendsOpenBeforeDataAndFin() {
    val emitted = ArrayList<ByteArray>()
    val mux = TunnelMux(cipher(), emitted::add, {}, {})
    val peer = cipher()
    val stream = mux.open({}, {}, {})
    val sent = CompletableFuture<Unit>()
    mux.write(stream, ByteArray(100), sent)
    mux.end(stream)
    mux.pump()
    assertEquals(
      listOf(1 to stream.id, 2 to stream.id, 4 to stream.id),
      frameHeaders(peer.open(emitted.single()))
    )
    assertTrue(sent.isDone)
  }

  @Test
  fun givesEachSaturatedStreamATurnBeforeDrainingTheFirst() {
    val emitted = ArrayList<ByteArray>()
    val mux = TunnelMux(cipher(), emitted::add, {}, {})
    val peer = cipher()
    val streams = List(3) { mux.open({}, {}, {}) }
    val sent = streams.map { stream ->
      CompletableFuture<Unit>().also { mux.write(stream, ByteArray(TunnelMux.MAX_PLAIN), it) }
    }
    mux.pump()
    val dataStreams = emitted.flatMap { frameHeaders(peer.open(it)) }
      .filter { it.first == 2 }.map { it.second }
    assertEquals(streams.map { it.id }, dataStreams.take(3))
    assertTrue(sent.all { it.isDone })
  }

  @Test
  fun validatesTheWholeRecordBeforeDeliveryOrCreditReservation() {
    val deliveries = ArrayList<TunnelMux.Delivery>()
    val mux = TunnelMux(cipher(), {}, {}, {})
    val peer = cipher()
    val stream = mux.open(deliveries::add, {}, {})
    val record = peer.seal(
      TunnelMux.frame(2, stream.id, byteArrayOf(1, 2)) +
        TunnelMux.frame(4, stream.id, byteArrayOf(3))
    )
    assertFails { mux.receive(record) }
    assertTrue(deliveries.isEmpty())
    assertEquals(0, mux.outstandingReceiveBytes)
  }

  @Test
  fun recognizesFragmentedUpgradeAfterAnInterimResponse() {
    val upgrade = CompletableFuture<Boolean>()
    val watcher = HttpUpgradeWatcher(upgrade)
    val response = (
      "HTTP/1.1 100 Continue\r\n\r\n" +
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
      ).toByteArray()
    watcher.observe(response.copyOfRange(0, response.size - 2))
    assertFalse(upgrade.isDone)
    watcher.observe(response.copyOfRange(response.size - 2, response.size))
    assertTrue(upgrade.join())
  }

  @Test
  fun keepsTheFirstFinalResponseUpgradeDecision() {
    val upgrade = CompletableFuture<Boolean>()
    val watcher = HttpUpgradeWatcher(upgrade)
    watcher.observe("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".toByteArray())
    assertFalse(upgrade.join())
    watcher.observe("HTTP/1.1 101 Switching Protocols\r\n\r\n".toByteArray())
    assertFalse(upgrade.join())
  }

  @Test
  fun rejectsOversizedResponseHeadersBeforeAcceptingAnUpgrade() {
    val upgrade = CompletableFuture<Boolean>()
    val watcher = HttpUpgradeWatcher(upgrade)
    assertFails {
      watcher.observe(("HTTP/1.1 101 Switching Protocols\r\nX: " + "a".repeat(65536)).toByteArray())
    }
    assertFalse(upgrade.isDone)
  }

  @Test
  fun returnsCreditOnlyAfterConsumptionAndChecksCumulativeStreamBudget() {
    val emitted = ArrayList<ByteArray>()
    val deliveries = ArrayList<TunnelMux.Delivery>()
    val mux = TunnelMux(cipher(), emitted::add, {}, {})
    val peer = cipher()
    val stream = mux.open(deliveries::add, {}, {})
    mux.pump()
    emitted.clear()
    repeat(64) { mux.receive(peer.seal(TunnelMux.frame(2, stream.id, ByteArray(65527)))) }
    mux.pump()
    assertTrue(emitted.isEmpty(), "No WINDOW may be sent before consumption")
    assertEquals(64 * 65527, mux.outstandingReceiveBytes)
    assertFails { mux.receive(peer.seal(TunnelMux.frame(2, stream.id, ByteArray(1024)))) }
    deliveries.forEach { mux.consumed(stream, it) }
    mux.pump()
    assertTrue(emitted.isNotEmpty())
    assertTrue(mux.outstandingReceiveBytes < TunnelMux.SESSION_WINDOW / 4)
    mux.close(IllegalStateException("test"))
  }

  @Test
  fun checksCumulativeSessionBudgetAcrossStreams() {
    val mux = TunnelMux(cipher(), {}, {}, {})
    val peer = cipher()
    val streams = List(3) { mux.open({}, {}, {}) }
    repeat(128) { i ->
      mux.receive(peer.seal(TunnelMux.frame(2, streams[i % 3].id, ByteArray(65527))))
    }
    assertFails { mux.receive(peer.seal(TunnelMux.frame(2, streams[0].id, ByteArray(2048)))) }
  }

  @Test
  fun rejectsASecondRequestsForeignHostAndAllowsChunkedBodies() {
    val header =
      "POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1:1234\r\nTransfer-Encoding: chunked\r\n\r\n"
    val valid = header + "3\r\nabc\r\n0\r\n\r\nGET /next HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n"
    val bytes = ArrayList<ByteArray>()
    LoopbackHttp.pipe(
      BufferedInputStream(ByteArrayInputStream(valid.toByteArray())),
      "127.0.0.1:1234",
      CompletableFuture(),
      bytes::add,
    )
    assertEquals(valid, bytes.fold(ByteArray(0)) { a, b -> a + b }.toString(Charsets.UTF_8))
    val wrong = valid + "GET /secret HTTP/1.1\r\nHost: evil.example\r\n\r\n"
    val sent = ArrayList<ByteArray>()
    assertFails {
      LoopbackHttp.pipe(
        BufferedInputStream(ByteArrayInputStream(wrong.toByteArray())),
        "127.0.0.1:1234",
        CompletableFuture(),
        sent::add,
      )
    }
    assertEquals(valid, sent.fold(ByteArray(0)) { a, b -> a + b }.toString(Charsets.UTF_8))
  }

  @Test
  fun sendFailureReleasesBlockedLocalWriter() {
    val mux = TunnelMux(cipher(), { throw IllegalStateException("transport closed") }, {}, {})
    val stream = mux.open({}, {}, {})
    val sent = CompletableFuture<Unit>()
    mux.write(stream, ByteArray(100), sent)
    assertFails { mux.pump() }
    assertTrue(sent.isCompletedExceptionally)
  }
}
