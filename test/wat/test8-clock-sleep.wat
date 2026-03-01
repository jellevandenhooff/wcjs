;; Test 8: Async clock sleep import.
;;
;; Imports `monotonic-now` (sync, returns u64) and `wait-for` (async, takes u64).
;; Gets the time, calls wait-for(10_000_000) [10ms], waits for subtask
;; completion, gets time again, verifies elapsed >= 10ms. Returns ok.
;;
;; This exercises:
;; - Sync host import (monotonic-now)
;; - Async host import (wait-for) via LowerImport
;; - Subtask creation + waitable-set + WAIT callback pattern
;; - Time verification after async sleep
;;
;; Modeled after wasmtime's p3_clocks_sleep test patterns.

(component
  (type $result-type (result))

  ;; Import clock functions from host
  (import "monotonic-now" (func $monotonic-now (result u64)))
  (import "wait-for" (func $wait-for (param "how-long" u64)))

  ;; Memory module — needed for async lowered import
  (core module $mem-mod (memory (export "memory") 1))
  (core instance $mem-inst (instantiate $mem-mod))

  ;; Lower sync import
  (core func $lowered-now (canon lower (func $monotonic-now)))

  ;; Lower async import
  (core func $lowered-wait-for
    (canon lower (func $wait-for) async (memory $mem-inst "memory")))

  (core module $m
    (import "mem" "memory" (memory 1))
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "context.get" (func $context.get (result i32)))
    (import "" "context.set" (func $context.set (param i32)))
    (import "" "monotonic-now" (func $now (result i64)))
    ;; Async lowered wait-for: (duration: i64) -> (subtask_packed: i32)
    ;; Note: wait-for takes u64 param, returns void, so no result_ptr
    (import "" "wait-for" (func $wait-for (param i64) (result i32)))
    (import "" "waitable-set.new" (func $ws.new (result i32)))
    (import "" "waitable.join" (func $w.join (param i32 i32)))
    (import "" "subtask.drop" (func $st.drop (param i32)))

    ;; Memory layout:
    ;; 0-7:  t1 (start time, i64)
    ;; 8-15: t2 (end time, i64)

    (func (export "run") (result i32)
      (local $subtask_packed i32)
      (local $subtask_handle i32)
      (local $subtask_state i32)
      (local $ws i32)

      ;; Step 1: Record start time
      (i64.store (i32.const 0) (call $now))

      ;; Step 2: Call wait-for with 10ms = 10_000_000 nanoseconds
      (local.set $subtask_packed (call $wait-for (i64.const 10000000)))
      (local.set $subtask_handle (i32.shr_u (local.get $subtask_packed) (i32.const 4)))
      (local.set $subtask_state (i32.and (local.get $subtask_packed) (i32.const 0xf)))

      ;; If already RETURNED (state >= 2), verify time and return
      (if (i32.ge_u (local.get $subtask_state) (i32.const 2))
        (then
          ;; Record end time
          (i64.store (i32.const 8) (call $now))
          (call $st.drop (local.get $subtask_handle))

          ;; Verify elapsed >= 10ms (10_000_000 ns)
          (if (i64.lt_u
                (i64.sub (i64.load (i32.const 8)) (i64.load (i32.const 0)))
                (i64.const 10000000))
            (then
              (call $task.return (i32.const 1))  ;; error
              (return (i32.const 0))
            )
          )

          (call $task.return (i32.const 0))  ;; ok
          (return (i32.const 0))  ;; EXIT
        )
      )

      ;; Not done yet — create waitable-set, join subtask
      (local.set $ws (call $ws.new))
      (call $w.join (local.get $subtask_handle) (local.get $ws))
      (call $context.set (local.get $ws))

      ;; Store subtask handle at memory[16]
      (i32.store (i32.const 16) (local.get $subtask_handle))

      ;; Return WAIT | (ws << 4)
      (i32.or
        (i32.shl (local.get $ws) (i32.const 4))
        (i32.const 2))  ;; WAIT
    )

    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      ;; Callback: event fired from waitable-set
      ;; $event = event code (1 = SUBTASK)
      ;; $p1 = waitable handle (subtask)
      ;; $p2 = payload (subtask state)

      ;; If state >= RETURNED (2), we're done
      (if (i32.ge_u (local.get $p2) (i32.const 2))
        (then
          ;; Record end time
          (i64.store (i32.const 8) (call $now))

          ;; Drop subtask
          (call $st.drop (local.get $p1))

          ;; Verify elapsed >= 10ms (10_000_000 ns)
          (if (i64.lt_u
                (i64.sub (i64.load (i32.const 8)) (i64.load (i32.const 0)))
                (i64.const 10000000))
            (then
              (call $task.return (i32.const 1))  ;; error: not enough time elapsed
              (return (i32.const 0))  ;; EXIT
            )
          )

          (call $task.return (i32.const 0))  ;; ok
          (return (i32.const 0))  ;; EXIT
        )
      )

      ;; Not done yet — WAIT again
      (i32.or
        (i32.shl (call $context.get) (i32.const 4))
        (i32.const 2))  ;; WAIT
    )
  )

  (canon task.return (result $result-type) (core func $task.return))
  (core func $context.get (canon context.get i32 0))
  (core func $context.set (canon context.set i32 0))
  (canon waitable-set.new (core func $ws.new))
  (canon waitable.join (core func $w.join))
  (canon subtask.drop (core func $st.drop))

  (core instance $i (instantiate $m
    (with "mem" (instance $mem-inst))
    (with "" (instance
      (export "task.return" (func $task.return))
      (export "context.get" (func $context.get))
      (export "context.set" (func $context.set))
      (export "monotonic-now" (func $lowered-now))
      (export "wait-for" (func $lowered-wait-for))
      (export "waitable-set.new" (func $ws.new))
      (export "waitable.join" (func $w.join))
      (export "subtask.drop" (func $st.drop))
    ))
  ))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run)  )
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
