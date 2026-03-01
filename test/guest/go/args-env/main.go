package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Printf("args=%v\n", os.Args)
	fmt.Printf("HOME=%s\n", os.Getenv("HOME"))
}
