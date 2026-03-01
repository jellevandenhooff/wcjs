package main

import (
	"fmt"
	"time"
)

func main() {
	start := time.Now()
	time.Sleep(10 * time.Millisecond)
	elapsed := time.Since(start).Milliseconds()
	fmt.Printf("elapsed=%dms\n", elapsed)
}
