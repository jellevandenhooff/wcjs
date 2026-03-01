;; Test 7: Sync clock imports.
;;
;; Imports `monotonic-now` (sync, returns u64) and `monotonic-resolution`
;; (sync, returns u64). Calls now() twice, verifies the second value is
;; >= the first (monotonicity). Checks resolution is > 0. Returns ok.
;;
;; Modeled after wasmtime's p3_clocks_sleep test patterns.

(component
  (type $result-type (result))

  ;; Import sync clock functions from host
  (import "monotonic-now" (func $monotonic-now (result u64)))
  (import "monotonic-resolution" (func $monotonic-resolution (result u64)))

  (core module $m
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "monotonic-now" (func $now (result i64)))
    (import "" "monotonic-resolution" (func $resolution (result i64)))

    (func (export "run") (result i32)
      (local $t1 i64)
      (local $t2 i64)
      (local $res i64)

      ;; Step 1: Get current time
      (local.set $t1 (call $now))

      ;; Step 2: Get current time again
      (local.set $t2 (call $now))

      ;; Step 3: Verify monotonicity: t2 >= t1
      (if (i64.lt_u (local.get $t2) (local.get $t1))
        (then
          (call $task.return (i32.const 1))
          (return (i32.const 0))  ;; EXIT with error
        )
      )

      ;; Step 4: Check resolution > 0
      (local.set $res (call $resolution))
      (if (i64.le_u (local.get $res) (i64.const 0))
        (then
          (call $task.return (i32.const 1))
          (return (i32.const 0))  ;; EXIT with error
        )
      )

      ;; Step 5: Return ok
      (call $task.return (i32.const 0))
      (i32.const 0)  ;; EXIT
    )

    ;; Callback (never called for instant EXIT)
    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      (unreachable)
    )
  )

  (canon task.return (result $result-type) (core func $task.return))

  ;; Lower sync imports (no async needed for sync functions)
  (core func $lowered-now (canon lower (func $monotonic-now)))
  (core func $lowered-resolution (canon lower (func $monotonic-resolution)))

  (core instance $i (instantiate $m
    (with "" (instance
      (export "task.return" (func $task.return))
      (export "monotonic-now" (func $lowered-now))
      (export "monotonic-resolution" (func $lowered-resolution))
    ))
  ))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (callback (func $run-cb))))

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
