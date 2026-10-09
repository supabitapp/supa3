package expo.modules.supacoderelaytunnel.core

import java.io.BufferedInputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

class NativeTunnel(
  private val relayUrl: String,
  hostAddress: String,
  port: Int = 0,
  private val onStatus: (Map<String, Any>) -> Unit = {},
  private val log: (String) -> Unit = {},
  private val keepaliveMillis: Long = 15_000,
  private val backgroundGraceMillis: Long = NativeTunnel.BACKGROUND_GRACE_MILLIS,
  private val probeTimeoutMillis: Long = 2_000
) : AutoCloseable {
  companion object {
    const val BACKGROUND_GRACE_MILLIS = 15_000L
  }
  private val identity = parseRelayIdentity(hostAddress)
  private val hostAddress =
    identity.hex().let { "https://${it.take(32)}.${it.drop(32)}.relay.supacode.invalid/" }
  private val actor = Executors.newSingleThreadScheduledExecutor {
    Thread(it, "relay-session").apply { isDaemon = true }
  }
  private val io = Executors.newCachedThreadPool {
    Thread(it, "relay-loopback").apply { isDaemon = true }
  }
  private val http =
    OkHttpClient.Builder()
      .pingInterval(20, TimeUnit.SECONDS)
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.SECONDS)
      .build()
  private val listener = ServerSocket()
  private val stopped = AtomicBoolean(false)
  private val slots = Semaphore(256)
  private val sockets = java.util.concurrent.ConcurrentHashMap.newKeySet<Socket>()
  private var attempt: CompletableFuture<TunnelMux>? = null
  private var mux: TunnelMux? = null
  private var webSocket: WebSocket? = null
  private var keepalive: ScheduledFuture<*>? = null
  private var backgroundClose: ScheduledFuture<*>? = null
  private var probeDeadline: ScheduledFuture<*>? = null
  private var pumpScheduled = false
  private var state = "down"
  private var suspended = false
  private var sentBytes = 0L
  private var receivedBytes = 0L
  private var sessions = 0
  private var lastStatus: Map<String, Any>? = null
  val origin: String

  init {
    require(port in 0..65535)
    val uri = java.net.URI(relayUrl)
    require(
      uri.scheme in listOf("ws", "wss") &&
        uri.host != null &&
        uri.userInfo == null &&
        uri.query == null &&
        uri.fragment == null
    )
    listener.reuseAddress = true
    try {
      listener.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
    } catch (error: IOException) {
      listener.close()
      actor.shutdown()
      io.shutdown()
      throw error
    }
    origin = "http://127.0.0.1:${listener.localPort}"
    log("[relay-android] listener origin=$origin ${CurveCrypto().provider}")
    actor.execute { connect() }
    io.execute {
      while (!stopped.get()) {
        try {
          val socket = listener.accept()
          if (!slots.tryAcquire()) {
            socket.close()
            continue
          }
          socket.tcpNoDelay = true
          socket.soTimeout = 0
          sockets.add(socket)
          io.execute { serve(socket) }
        } catch (error: IOException) {
          if (!stopped.get()) log("[relay-android] accept failed: ${error.javaClass.simpleName}")
        } catch (error: RejectedExecutionException) {
          if (!stopped.get()) log("[relay-android] accept failed: ${error.javaClass.simpleName}")
        }
      }
    }
  }

  private fun emit(error: String? = null) {
    val value =
      linkedMapOf<String, Any>(
        "state" to state,
        "origin" to origin,
        "hostAddress" to hostAddress,
        "bytesSent" to sentBytes,
        "bytesReceived" to receivedBytes,
        "activeStreams" to (mux?.streamCount ?: 0),
        "sessionCount" to sessions,
      )
    if (error != null) value["reason"] = error
    if (value == lastStatus) return
    lastStatus = value
    log(
      "[relay-android] $state origin=$origin sessions=$sessions " +
        "streams=${mux?.streamCount ?: 0} up=$sentBytes down=$receivedBytes"
    )
    onStatus(value)
  }

  private fun connect(): CompletableFuture<TunnelMux> {
    attempt?.let { return it }
    val future = CompletableFuture<TunnelMux>()
    if (stopped.get() || suspended) {
      future.completeExceptionally(IllegalStateException("Tunnel unavailable"))
    } else {
      attempt = future
      state = "connecting"
      emit()
      log("[relay-android] session connecting")
      dial(future)
    }
    return future
  }

  @Suppress("TooGenericExceptionCaught")
  private fun failOnError(future: CompletableFuture<TunnelMux>, block: () -> Unit) {
    try {
      block()
    } catch (error: Exception) {
      fail(future, error)
    }
  }

  private fun dial(future: CompletableFuture<TunnelMux>) = failOnError(future) {
    val handshake = ClientHandshake(identity)
    future.whenComplete { _, _ -> handshake.destroy() }
    val timeout = actor.schedule(
      { fail(future, IllegalStateException("Relay handshake timed out")) },
      15,
      TimeUnit.SECONDS,
    )
    future.whenComplete { _, _ ->
      timeout.cancel(false)
    }
    webSocket = http.newWebSocket(
      Request.Builder()
        .url(relayUrl.trimEnd('/') + "/v1/connect?endpointId=" + sha256(identity).hex())
        .build(),
      object : WebSocketListener() {
        override fun onOpen(socket: WebSocket, response: Response) {
          post {
            if (attempt === future && !socket.send(handshake.hello)) {
              fail(future, IllegalStateException("Relay send failed"))
            }
          }
        }

        override fun onMessage(socket: WebSocket, text: String) {
          post {
            if (attempt !== future) return@post
            failOnError(future) {
              check(mux == null) { "Unencrypted relay message" }
              val session = TunnelMux(
                handshake.finish(text),
                { record -> check(socket.send(record.toByteString())) { "Relay queue full" } },
                ::schedulePump,
                { sentBytes += it },
                { probeDeadline?.cancel(false); probeDeadline = null },
              )
              mux = session
              keepalive = actor.scheduleWithFixedDelay(
                { failOnError(future) { session.tick() } },
                keepaliveMillis,
                keepaliveMillis,
                TimeUnit.MILLISECONDS,
              )
              sessions++
              state = "up"
              emit()
              log("[relay-android] session $sessions up")
              future.complete(session)
            }
          }
        }

        override fun onMessage(socket: WebSocket, bytes: ByteString) {
          post {
            if (attempt !== future) return@post
            failOnError(future) {
              (mux ?: error("Binary handshake")).receive(bytes.toByteArray())
            }
          }
        }

        override fun onClosing(socket: WebSocket, code: Int, reason: String) {
          socket.close(1000, null)
          post { fail(future, IllegalStateException("Relay disconnected ($code)")) }
        }

        override fun onClosed(socket: WebSocket, code: Int, reason: String) {
          post { fail(future, IllegalStateException("Relay disconnected ($code)")) }
        }

        override fun onFailure(socket: WebSocket, error: Throwable, response: Response?) {
          post { fail(future, error) }
        }
      },
    )
  }

  private fun post(block: () -> Unit): Boolean {
    if (!actor.isShutdown) {
      try {
        actor.execute(block)
        return true
      } catch (_: java.util.concurrent.RejectedExecutionException) {}
    }
    return false
  }

  private fun fail(future: CompletableFuture<TunnelMux>, error: Throwable) {
    if (attempt !== future) return
    attempt = null
    keepalive?.cancel(false)
    keepalive = null
    probeDeadline?.cancel(false)
    probeDeadline = null
    mux?.close(error)
    mux = null
    webSocket?.cancel()
    webSocket = null
    future.completeExceptionally(error)
    state = "down"
    emit(error.message ?: "Relay disconnected")
    log("[relay-android] session down: ${error.javaClass.simpleName}: ${error.message}")
  }

  private fun schedulePump() {
    if (pumpScheduled || stopped.get()) return
    pumpScheduled = true
    actor.execute {
      pumpScheduled = false
      attempt?.let { future -> failOnError(future) { mux?.pump() } }
    }
  }

  @Suppress("TooGenericExceptionCaught")
  private fun <T> onActor(block: () -> T): CompletableFuture<T> {
    val future = CompletableFuture<T>()
    if (!post {
      try {
        future.complete(block())
      } catch (error: Exception) {
        future.completeExceptionally(error)
      }
    }) future.completeExceptionally(IllegalStateException("Tunnel unavailable"))
    return future
  }

  private fun write(session: TunnelMux, stream: TunnelMux.Stream, bytes: ByteArray) {
    onActor {
      CompletableFuture<Unit>().also { session.write(stream, bytes, it) }
    }.thenCompose { it }.get()
  }

  private class Incoming(val bytes: ByteArray? = null)

  @Suppress("TooGenericExceptionCaught")
  private fun serve(socket: Socket) {
    var stream: TunnelMux.Stream? = null
    var session: TunnelMux? = null
    val queue = LinkedBlockingQueue<Incoming>()
    val upgrade = CompletableFuture<Boolean>()
    val closed = AtomicBoolean(false)
    fun finishSocket() {
      if (closed.compareAndSet(false, true)) {
        queue.add(Incoming())
        upgrade.complete(false)
        try {
          socket.close()
        } catch (_: IOException) {
        } finally {
          sockets.remove(socket)
          slots.release()
        }
      }
    }
    try {
      session = onActor { connect() }.thenCompose { it }.get(20, TimeUnit.SECONDS)
      val selected = session
      stream = onActor {
        selected.open(
          { bytes ->
            receivedBytes += bytes.size
            queue.add(Incoming(bytes))
          },
          { queue.add(Incoming()) },
          { finishSocket() },
        )
      }.get(20, TimeUnit.SECONDS)
      val active = stream
      io.execute {
        val response = HttpUpgradeWatcher(upgrade)
        try {
          val output = socket.getOutputStream()
          while (!closed.get()) {
            val incoming = queue.take().bytes ?: break
            output.write(incoming)
            response.observe(incoming)
            post { selected.consumed(active, incoming.size) }
          }
          if (!socket.isClosed) socket.shutdownOutput()
        } catch (error: Exception) {
          post { selected.reset(active, error) }
          finishSocket()
        }
      }
      LoopbackHttp.pipe(
        BufferedInputStream(socket.getInputStream(), 65536),
        "127.0.0.1:${listener.localPort}",
        upgrade,
        { bytes -> write(selected, active, bytes) },
      )
      post { selected.end(active) }
    } catch (error: Exception) {
      val active = stream
      val selected = session
      if (active != null && selected != null) post { selected.reset(active, error) }
      finishSocket()
    }
  }

  fun suspend() = post {
    backgroundClose?.cancel(false)
    backgroundClose = null
    suspendSession()
  }

  private fun suspendSession() {
    suspended = true
    attempt?.let { fail(it, IllegalStateException("Backgrounded")) }
  }

  fun background(graceMillis: Long = backgroundGraceMillis) = post {
    backgroundClose?.cancel(false)
    backgroundClose = actor.schedule({
      backgroundClose = null
      suspendSession()
    }, graceMillis, TimeUnit.MILLISECONDS)
  }

  fun resume() = post {
    backgroundClose?.cancel(false)
    backgroundClose = null
    suspended = false
    log("[relay-android] foregrounded origin=$origin")
    val current = attempt
    val session = mux
    if (current == null || session == null) {
      current?.let { fail(it, IllegalStateException("Relay resumed during handshake")) }
      connect()
    } else {
      probeDeadline?.cancel(false)
      probeDeadline = actor.schedule({
        fail(current, IllegalStateException("Relay resume probe timed out"))
        connect()
      }, probeTimeoutMillis, TimeUnit.MILLISECONDS)
      session.ping()
    }
  }

  override fun close() {
    if (!stopped.compareAndSet(false, true)) return
    listener.close()
    sockets.forEach { it.close() }
    actor.execute {
      backgroundClose?.cancel(false)
      attempt?.let { fail(it, IllegalStateException("Tunnel unavailable")) }
      state = "down"
      emit()
    }
    actor.shutdown()
    io.shutdownNow()
    http.dispatcher.executorService.shutdown()
    http.connectionPool.evictAll()
  }
}
