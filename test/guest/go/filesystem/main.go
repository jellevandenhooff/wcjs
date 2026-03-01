package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	dir := os.TempDir()
	testFile := filepath.Join(dir, "wasip3-test.txt")

	// Write a file
	err := os.WriteFile(testFile, []byte("hello filesystem"), 0644)
	if err != nil {
		fmt.Printf("write error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("write ok")

	// Read it back
	data, err := os.ReadFile(testFile)
	if err != nil {
		fmt.Printf("read error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("read ok: %s\n", string(data))

	// Stat
	info, err := os.Stat(testFile)
	if err != nil {
		fmt.Printf("stat error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("stat ok: size=%d\n", info.Size())

	// Readdir
	entries, err := os.ReadDir(dir)
	if err != nil {
		fmt.Printf("readdir error: %v\n", err)
		os.Exit(1)
	}
	found := false
	for _, e := range entries {
		if e.Name() == "wasip3-test.txt" {
			found = true
		}
	}
	fmt.Printf("readdir ok: found=%v\n", found)

	// Remove
	err = os.Remove(testFile)
	if err != nil {
		fmt.Printf("remove error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("remove ok")

	fmt.Println("all filesystem tests passed")
}
