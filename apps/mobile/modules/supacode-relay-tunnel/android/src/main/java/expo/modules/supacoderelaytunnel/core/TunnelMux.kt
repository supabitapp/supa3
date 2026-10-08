package expo.modules.supacoderelaytunnel.core

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.CompletableFuture

internal class TunnelMux(
  private val cipher: RelayCipher,
  private val sendRecord: (ByteArray) -> Unit,
  private val schedulePump: () -> Unit,
  private val onDataSent: (Int) -> Unit
) {
  companion object {
    const val SESSION_WINDOW = 8 * 1024 * 1024
    const val STREAM_WINDOW = 4 * 1024 * 1024
    const val MIN_COST = 48 * 1024
    const val MAX_PLAIN = 64 * 1024

    fun frame(type: Int, id: Int, data: ByteArray = ByteArray(0)): ByteArray =
      ByteBuffer.allocate(9 + data.size)
        .put(type.toByte())
        .putInt(id)
        .putInt(data.size)
        .put(data)
        .array()

    fun window(id: Int, bytes: Int) = frame(3, id, ByteBuffer.allocate(4).putInt(bytes).array())
  }

  internal class Receipt(val cost: Int, var remaining: Int)

  internal class Delivery(val bytes: ByteArray, val receipt: Receipt) {
    var consumed = false
  }

  internal class Pending(val bytes: ByteArray, val done: CompletableFuture<Unit>) {
    var offset = 0
  }

  internal class Stream(
    val id: Int,
    val data: (Delivery) -> Unit,
    val end: () -> Unit,
    val close: (Throwable?) -> Unit
  ) {
    val pending = ArrayDeque<Pending>()
    val deliveries = LinkedHashSet<Delivery>()
    var sendCredit = STREAM_WINDOW
    var receiveCredit = STREAM_WINDOW
    var grant = 0
    var localEnded = false
    var finSent = false
    var remoteEnded = false
    var closed = false
    val needsFin get() = localEnded && !finSent && pending.isEmpty()
    val wantsSend get() = !closed && (pending.isNotEmpty() || needsFin)
  }

  private val streams = LinkedHashMap<Int, Stream>()
  private val control = ArrayDeque<ByteArray>()
  private val ready = LinkedHashSet<Stream>()
  private var nextId = 1
  private var sendCredit = SESSION_WINDOW
  private var receiveCredit = SESSION_WINDOW
  private var grant = 0
  var closed = false
    private set

  val streamCount
    get() = streams.size

  val outstandingReceiveBytes
    get() = SESSION_WINDOW - receiveCredit

  fun open(data: (Delivery) -> Unit, end: () -> Unit, close: (Throwable?) -> Unit): Stream {
    check(!closed && streams.size < 256 && nextId > 0) { "Tunnel stream limit reached" }
    val stream = Stream(nextId, data, end, close)
    nextId += 2
    streams[stream.id] = stream
    control.add(frame(1, stream.id))
    schedulePump()
    return stream
  }

  fun write(stream: Stream, bytes: ByteArray, done: CompletableFuture<Unit>) {
    check(!closed && !stream.closed && !stream.localEnded)
    require(bytes.size <= MAX_PLAIN)
    stream.pending.add(Pending(bytes, done))
    ready.add(stream)
    schedulePump()
  }

  fun end(stream: Stream) {
    if (closed || stream.closed) return
    stream.localEnded = true
    ready.add(stream)
    schedulePump()
  }

  fun reset(stream: Stream, error: Throwable? = null) {
    if (closed || stream.closed) return
    control.add(frame(5, stream.id))
    finish(stream, error ?: IllegalStateException("Local stream closed"))
    schedulePump()
  }

  private fun finish(stream: Stream, error: Throwable?) {
    if (stream.closed) return
    stream.closed = true
    streams.remove(stream.id)
    ready.remove(stream)
    for (pending in stream.pending) {
      pending.done.completeExceptionally(
        error ?: IllegalStateException("Stream closed")
      )
    }
    stream.pending.clear()
    for (delivery in stream.deliveries.toList()) consumed(stream, delivery)
    stream.close(error)
  }

  private fun maybeFinish(stream: Stream) {
    if (stream.finSent && stream.remoteEnded && stream.deliveries.isEmpty()) finish(stream, null)
  }

  fun consumed(stream: Stream, delivery: Delivery) {
    if (delivery.consumed) return
    delivery.consumed = true
    stream.deliveries.remove(delivery)
    if (closed) return
    val receipt = delivery.receipt
    receipt.remaining -= delivery.bytes.size
    if (receipt.remaining == 0) {
      grant += receipt.cost
      if (grant >= SESSION_WINDOW / 4) {
        control.add(window(0, grant))
        receiveCredit += grant
        grant = 0
        schedulePump()
      }
    }
    if (!stream.closed) {
      stream.grant += delivery.bytes.size
      if (stream.grant >= STREAM_WINDOW / 4) {
        control.add(window(stream.id, stream.grant))
        stream.receiveCredit += stream.grant
        stream.grant = 0
        schedulePump()
      }
      maybeFinish(stream)
    }
  }

  fun pump() {
    while (!closed) {
      val plain = ByteArrayOutputStream(MAX_PLAIN)
      val callbacks = ArrayList<CompletableFuture<Unit>>()
      var dataBytes = 0
      while (control.isNotEmpty() && plain.size() + control.first.size <= MAX_PLAIN) {
        plain.write(control.removeFirst())
      }
      for (stream in ready.toList()) {
        if (MAX_PLAIN - plain.size() < 9) break
        ready.remove(stream)
        dataBytes += writeStream(stream, plain, callbacks, dataBytes)
        if (stream.wantsSend) ready.add(stream)
      }
      if (plain.size() == 0) return
      flush(plain, callbacks, dataBytes)
    }
  }

  private fun writeStream(
    stream: Stream,
    plain: ByteArrayOutputStream,
    callbacks: MutableList<CompletableFuture<Unit>>,
    dataBytes: Int
  ): Int {
    val pending = stream.pending.peekFirst()
    val room = minOf(
      MAX_PLAIN - plain.size() - 9,
      stream.sendCredit,
      if (sendCredit >= MIN_COST) sendCredit - dataBytes else 0,
    )
    var count = 0
    if (pending != null && room > 0) {
      count = minOf(room, pending.bytes.size - pending.offset)
      plain.write(
        frame(
          2,
          stream.id,
          pending.bytes.copyOfRange(
            pending.offset,
            pending.offset + count
          )
        )
      )
      pending.offset += count
      stream.sendCredit -= count
      if (pending.offset == pending.bytes.size) {
        stream.pending.removeFirst()
        callbacks.add(pending.done)
      }
    }
    if (stream.needsFin && MAX_PLAIN - plain.size() >= 9) {
      plain.write(frame(4, stream.id))
      stream.finSent = true
      maybeFinish(stream)
    }
    return count
  }

  @Suppress("TooGenericExceptionCaught")
  private fun flush(
    plain: ByteArrayOutputStream,
    callbacks: List<CompletableFuture<Unit>>,
    dataBytes: Int
  ) {
    if (dataBytes > 0) sendCredit -= maxOf(dataBytes, MIN_COST)
    try {
      sendRecord(cipher.seal(plain.toByteArray()))
    } catch (error: Exception) {
      callbacks.forEach { it.completeExceptionally(error) }
      throw error
    }
    onDataSent(dataBytes)
    callbacks.forEach { it.complete(Unit) }
  }

  private class Frame(val type: Int, val id: Int, val data: ByteArray)

  fun receive(record: ByteArray) {
    check(!closed)
    val frames = decode(ByteBuffer.wrap(cipher.open(record)))
    val bytes = frames.sumOf { if (it.type == 2) it.data.size else 0 }
    val receipt = Receipt(if (bytes > 0) maxOf(bytes, MIN_COST) else 0, bytes)
    require(receipt.cost <= receiveCredit) { "Session receive window exceeded" }
    receiveCredit -= receipt.cost
    for (frame in frames) dispatch(frame, receipt)
  }

  private fun decode(plain: ByteBuffer): List<Frame> {
    val frames = ArrayList<Frame>()
    while (plain.hasRemaining()) {
      require(plain.remaining() >= 9) { "Truncated tunnel frame" }
      val type = plain.get().toInt() and 255
      val id = plain.int
      val size = plain.int
      require(size >= 0 && size <= plain.remaining()) { "Truncated tunnel frame" }
      val payload = ByteArray(size).also { plain.get(it) }
      require(type in 2..5) { "Unexpected tunnel frame" }
      require(type == 2 || size == if (type == 3) 4 else 0) { "Invalid control frame" }
      if (type == 2) require(size > 0 && id > 0)
      frames.add(Frame(type, id, payload))
    }
    return frames
  }

  private fun dispatch(frame: Frame, receipt: Receipt) {
    val stream = streams[frame.id]
    when (frame.type) {
      3 -> grantSend(stream, frame)
      2 -> deliver(stream, frame, receipt)
      4 -> if (stream != null && !stream.remoteEnded) {
        stream.remoteEnded = true
        stream.end()
        maybeFinish(stream)
      }
      5 -> if (stream != null) finish(stream, IllegalStateException("Remote stream reset"))
    }
  }

  private fun grantSend(stream: Stream?, frame: Frame) {
    val credit = ByteBuffer.wrap(frame.data).int
    require(credit > 0)
    if (frame.id == 0) {
      require(credit <= SESSION_WINDOW - sendCredit)
      sendCredit += credit
    } else if (stream != null) {
      require(credit <= STREAM_WINDOW - stream.sendCredit)
      stream.sendCredit += credit
    }
    schedulePump()
  }

  private fun deliver(stream: Stream?, frame: Frame, receipt: Receipt) {
    val delivery = Delivery(frame.data, receipt)
    if (stream == null) {
      consumed(Stream(frame.id, {}, {}, {}).also { it.closed = true }, delivery)
    } else {
      require(!stream.remoteEnded && frame.data.size <= stream.receiveCredit) {
        "Stream receive window exceeded"
      }
      stream.receiveCredit -= frame.data.size
      stream.deliveries.add(delivery)
      stream.data(delivery)
    }
  }

  fun close(error: Throwable) {
    if (closed) return
    closed = true
    streams.values.toList().forEach { finish(it, error) }
    control.clear()
    ready.clear()
    cipher.destroy()
  }
}
