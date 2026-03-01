;; Test 5: Basic stream operations.
;;
;; Creates a stream pair, drops the writable end, reads from the readable
;; end (should get DROPPED result), drops the readable end, returns ok.
;;
;; This exercises: stream.new, stream.drop-writable, stream.read,
;; stream.drop-readable, and memory extraction.

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
  (canon stream.drop-readable $ST (core func $stream.drop-readable))
  (canon stream.drop-writable $ST (core func $stream.drop-writable))

  (core module $m
    (import "mem" "memory" (memory 1))
    (import "" "task.return" (func $task.return (param i32)))
    ;; stream.new returns i64: lower 32 bits = readable, upper 32 bits = writable
    (import "" "stream.new" (func $stream.new (result i64)))
    ;; stream.read: (endIdx, ptr, count) -> packed i32
    (import "" "stream.read" (func $stream.read (param i32 i32 i32) (result i32)))
    (import "" "stream.drop-readable" (func $stream.drop-readable (param i32)))
    (import "" "stream.drop-writable" (func $stream.drop-writable (param i32)))

    (func (export "run") (result i32)
      (local $ret64 i64)
      (local $rx i32)   ;; readable end handle
      (local $tx i32)   ;; writable end handle
      (local $read_ret i32)

      ;; Step 1: Create stream pair
      (local.set $ret64 (call $stream.new))
      ;; Extract rx (lower 32 bits) and tx (upper 32 bits)
      (local.set $rx (i32.wrap_i64 (local.get $ret64)))
      (local.set $tx (i32.wrap_i64 (i64.shr_u (local.get $ret64) (i64.const 32))))

      ;; Step 2: Drop the writable end
      ;; After this, any read should return DROPPED
      (call $stream.drop-writable (local.get $tx))

      ;; Step 3: Read from the readable end
      ;; Expect DROPPED result (CopyResult.DROPPED = 1, progress = 0)
      ;; So return value should be 1 (= 1 | (0 << 4))
      (local.set $read_ret (call $stream.read
        (local.get $rx)
        (i32.const 64)   ;; buffer ptr (arbitrary, won't be used)
        (i32.const 4)))  ;; count

      ;; Verify read returned DROPPED (1)
      (if (i32.ne (local.get $read_ret) (i32.const 1))
        (then
          ;; Unexpected result — return error
          (call $task.return (i32.const 1))
          (return (i32.const 0))  ;; EXIT
        )
      )

      ;; Step 4: Drop the readable end
      (call $stream.drop-readable (local.get $rx))

      ;; Step 5: Return ok
      (call $task.return (i32.const 0))
      (i32.const 0)  ;; EXIT
    )

    ;; Callback function (required for callback mode, even if never called)
    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      ;; Should never be called for this test (instant EXIT)
      (unreachable)
    )
  )

  (canon task.return (result $result-type) (core func $task.return))

  (core instance $i (instantiate $m
    (with "mem" (instance $mem-inst))
    (with "" (instance
      (export "task.return" (func $task.return))
      (export "stream.new" (func $stream.new))
      (export "stream.read" (func $stream.read))
      (export "stream.drop-readable" (func $stream.drop-readable))
      (export "stream.drop-writable" (func $stream.drop-writable))
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
