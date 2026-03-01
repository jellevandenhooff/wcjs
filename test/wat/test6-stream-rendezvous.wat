;; Test 6: Stream rendezvous with data transfer.
;;
;; Creates a stream pair, writes data (async, BLOCKED), then reads (triggers
;; rendezvous), verifies data, WAITs for STREAM_WRITE event, drops both ends.
;;
;; Pattern:
;; 1. stream.new → (rx, tx)
;; 2. stream.write(tx, src, 4, async) → BLOCKED (no reader)
;; 3. stream.read(rx, dst, 4, async) → rendezvous! Returns COMPLETED + 4 bytes
;; 4. Verify data at dst matches src
;; 5. Return WAIT (writer has pending STREAM_WRITE event from rendezvous)
;; 6. Callback: drop both ends, return EXIT ok

(component
  (type $result-type (result))

  ;; Memory module
  (core module $mem-mod (memory (export "memory") 1))
  (core instance $mem-inst (instantiate $mem-mod))

  ;; Stream type: stream<u8>
  (type $ST (stream u8))

  ;; Canon stream builtins
  (canon stream.new $ST (core func $stream.new))
  (canon stream.read $ST async (memory $mem-inst "memory") (core func $stream.read))
  (canon stream.write $ST async (memory $mem-inst "memory") (core func $stream.write))
  (canon stream.drop-readable $ST (core func $stream.drop-readable))
  (canon stream.drop-writable $ST (core func $stream.drop-writable))

  (core module $m
    (import "mem" "memory" (memory 1))
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "context.get" (func $context.get (result i32)))
    (import "" "context.set" (func $context.set (param i32)))
    (import "" "stream.new" (func $stream.new (result i64)))
    (import "" "stream.read" (func $stream.read (param i32 i32 i32) (result i32)))
    (import "" "stream.write" (func $stream.write (param i32 i32 i32) (result i32)))
    (import "" "stream.drop-readable" (func $stream.drop-readable (param i32)))
    (import "" "stream.drop-writable" (func $stream.drop-writable (param i32)))
    (import "" "waitable-set.new" (func $ws.new (result i32)))
    (import "" "waitable.join" (func $w.join (param i32 i32)))

    ;; Memory layout:
    ;; 0-3:   source data (bytes to write)
    ;; 16-19: destination buffer (bytes read)
    ;; 32-35: rx handle
    ;; 36-39: tx handle
    ;; 40-43: waitable-set handle

    (func (export "run") (result i32)
      (local $ret64 i64)
      (local $rx i32)
      (local $tx i32)
      (local $ws i32)
      (local $write_ret i32)
      (local $read_ret i32)
      (local $result_code i32)
      (local $progress i32)

      ;; Write source data: bytes [0xDE, 0xAD, 0xBE, 0xEF]
      (i32.store (i32.const 0) (i32.const 0xEFBEADDE))

      ;; Step 1: Create stream pair
      (local.set $ret64 (call $stream.new))
      (local.set $rx (i32.wrap_i64 (local.get $ret64)))
      (local.set $tx (i32.wrap_i64 (i64.shr_u (local.get $ret64) (i64.const 32))))

      ;; Create waitable-set and join both ends
      (local.set $ws (call $ws.new))
      (call $w.join (local.get $tx) (local.get $ws))
      (call $w.join (local.get $rx) (local.get $ws))

      ;; Save handles for callback
      (i32.store (i32.const 32) (local.get $rx))
      (i32.store (i32.const 36) (local.get $tx))
      (call $context.set (local.get $ws))

      ;; Step 2: Write 4 bytes (async) → should return BLOCKED
      (local.set $write_ret (call $stream.write
        (local.get $tx)
        (i32.const 0)    ;; src ptr
        (i32.const 4)))  ;; count = 4 bytes

      ;; Verify write returned BLOCKED (0xFFFFFFFF = -1 as i32)
      (if (i32.ne (local.get $write_ret) (i32.const -1))
        (then
          (call $task.return (i32.const 1))
          (return (i32.const 0))
        )
      )

      ;; Step 3: Read 4 bytes from rx → triggers rendezvous
      (local.set $read_ret (call $stream.read
        (local.get $rx)
        (i32.const 16)   ;; dst ptr
        (i32.const 4)))  ;; count = 4 bytes

      ;; Unpack: result_code = lower 4 bits, progress = upper bits
      (local.set $result_code (i32.and (local.get $read_ret) (i32.const 0xf)))
      (local.set $progress (i32.shr_u (local.get $read_ret) (i32.const 4)))

      ;; Verify: result code should be COMPLETED (0)
      (if (i32.ne (local.get $result_code) (i32.const 0))
        (then
          (call $task.return (i32.const 1))
          (return (i32.const 0))
        )
      )

      ;; Verify: progress should be 4
      (if (i32.ne (local.get $progress) (i32.const 4))
        (then
          (call $task.return (i32.const 1))
          (return (i32.const 0))
        )
      )

      ;; Step 4: Verify data at dst matches source
      (if (i32.ne (i32.load (i32.const 16)) (i32.const 0xEFBEADDE))
        (then
          (call $task.return (i32.const 1))
          (return (i32.const 0))
        )
      )

      ;; Step 5: WAIT for the STREAM_WRITE event (writer needs cleanup)
      ;; The rendezvous set a pending event on the writable end.
      (i32.or
        (i32.shl (local.get $ws) (i32.const 4))
        (i32.const 2))  ;; WAIT
    )

    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      ;; Step 6: Got STREAM_WRITE event — clean up
      (local $rx i32)
      (local $tx i32)

      (local.set $rx (i32.load (i32.const 32)))
      (local.set $tx (i32.load (i32.const 36)))

      ;; Drop both stream ends
      (call $stream.drop-writable (local.get $tx))
      (call $stream.drop-readable (local.get $rx))

      ;; Return ok
      (call $task.return (i32.const 0))
      (i32.const 0)  ;; EXIT
    )
  )

  (canon task.return (result $result-type) (core func $task.return))
  (core func $context.get (canon context.get i32 0))
  (core func $context.set (canon context.set i32 0))
  (canon waitable-set.new (core func $canon-ws-new))
  (canon waitable.join (core func $canon-w-join))

  (core instance $i (instantiate $m
    (with "mem" (instance $mem-inst))
    (with "" (instance
      (export "task.return" (func $task.return))
      (export "context.get" (func $context.get))
      (export "context.set" (func $context.set))
      (export "stream.new" (func $stream.new))
      (export "stream.read" (func $stream.read))
      (export "stream.write" (func $stream.write))
      (export "stream.drop-readable" (func $stream.drop-readable))
      (export "stream.drop-writable" (func $stream.drop-writable))
      (export "waitable-set.new" (func $canon-ws-new))
      (export "waitable.join" (func $canon-w-join))
    ))
  ))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (memory $mem-inst "memory") (callback (func $run-cb))))

  (component $shim
    (type $r (result))
    (type $run-func (func async (result $r)))
    (import "import-func-run" (func (type $run-func)))
    (type $r2 (result))
    (type $run-func2 (func async (result $r2)))
    (export "run" (func 0) (func (type $run-func2)))
  )
  (instance $shim-inst (instantiate $shim (with "import-func-run" (func $run))))
  (export "wasi:cli/run@0.3.0-rc-2026-01-06" (instance $shim-inst))
)
