package expo.modules.supacoderelaytunnel.core

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal object LoopbackHttp {
  fun pipe(
    input: BufferedInputStream,
    authority: String,
    upgrade: CompletableFuture<Boolean>,
    send: (ByteArray) -> Unit,
    request: (String) -> Unit = {},
  ) {
    var requests = 0
    while (true) {
      val header = readHeader(input) ?: return
      val lines = header.toString(Charsets.ISO_8859_1).split("\r\n")
      val first = lines.first().split(' ')
      require(
        first.size == 3 &&
          first[2] == "HTTP/1.1" &&
          first[1].startsWith("/") &&
          !first[1].startsWith("//")
      ) {
        "Invalid HTTP request"
      }
      val fields = LinkedHashMap<String, MutableList<String>>()
      for (line in lines.drop(1).filter { it.isNotEmpty() }) {
        require(!line.startsWith(' ') && !line.startsWith('\t') && line.contains(':')) {
          "Invalid HTTP header"
        }
        val key = line.substringBefore(':').lowercase()
        require(Regex("[a-z0-9!#$%&'*+.^_`|~-]+").matches(key))
        fields.getOrPut(key) { ArrayList() }.add(line.substringAfter(':').trim())
      }
      require(fields["host"] == listOf(authority)) { "Misdirected loopback Host" }
      val length = fields["content-length"]
      val transfer = fields["transfer-encoding"]
      require(length == null || (length.size == 1 && transfer == null)) { "Ambiguous HTTP body" }
      require(transfer == null || transfer == listOf("chunked")) { "Unsupported transfer encoding" }
      val contentLength =
        length?.single()?.let {
          require(Regex("[0-9]+").matches(it))
          it.toLong()
        } ?: 0
      val upgrading = fields["upgrade"] != null
      require(!upgrading || requests == 0 && contentLength == 0L && transfer == null) {
        "Upgrade requires a fresh connection"
      }
      request(first[0] + " " + safePath(first[1]))
      send(header)
      if (transfer != null) {
        while (true) {
          val line = readLine(input)
          val sizeText = line.toString(Charsets.US_ASCII).trim().substringBefore(';')
          require(Regex("[0-9a-fA-F]{1,15}").matches(sizeText)) { "Invalid chunk" }
          val size = sizeText.toLong(16)
          send(line)
          if (size == 0L) {
            var trailerBytes = 0
            while (true) {
              val trailer = readLine(input)
              trailerBytes += trailer.size
              require(trailerBytes <= 65536)
              send(trailer)
              if (trailer.size == 2) break
            }
            break
          }
          copy(input, size, send)
          val crlf = ByteArray(2)
          crlf[0] = input.read().toByte()
          crlf[1] = input.read().toByte()
          require(crlf.contentEquals(byteArrayOf(13, 10)))
          send(crlf)
        }
      } else copy(input, contentLength, send)
      requests++
      if (upgrading && upgrade.get(15, TimeUnit.SECONDS)) {
        val buffer = ByteArray(65500)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) return
          send(buffer.copyOf(count))
        }
      }
    }
  }

  private fun copy(input: BufferedInputStream, length: Long, send: (ByteArray) -> Unit) {
    var remaining = length
    val buffer = ByteArray(minOf(65500L, maxOf(1L, remaining)).toInt())
    while (remaining > 0) {
      val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
      if (count < 0) throw EOFException("Truncated HTTP body")
      send(buffer.copyOf(count))
      remaining -= count
    }
  }

  private fun readLine(input: BufferedInputStream): ByteArray {
    val line = ByteArrayOutputStream()
    var previous = -1
    while (line.size() <= 65536) {
      val next = input.read()
      if (next < 0) throw EOFException()
      line.write(next)
      if (previous == 13 && next == 10) return line.toByteArray()
      previous = next
    }
    error("HTTP line too large")
  }

  private fun readHeader(input: BufferedInputStream): ByteArray? {
    if (input.markSupported()) {
      input.mark(1)
      if (input.read() < 0) return null
      input.reset()
    }
    val header = ByteArrayOutputStream()
    while (header.size() <= 65536) {
      val line = readLine(input)
      header.write(line)
      if (line.size == 2) return header.toByteArray().also { require(it.size <= 65536) }
    }
    error("HTTP headers too large")
  }

  private fun safePath(target: String): String {
    val path = target.substringBefore('?')
    return when {
      path.startsWith("/api/assets/") -> "/api/assets/…"
      path.startsWith("/api/device-hub/") -> "/api/device-hub/…"
      else -> path.take(160)
    }
  }
}
