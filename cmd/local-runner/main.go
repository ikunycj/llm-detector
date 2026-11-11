package main

import (
	"context"
	"flag"
	"fmt"
	"llm-detector/internal/localruntime"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	port := flag.Int("port", 9002, "loopback port")
	originsFlag := flag.String("origin", os.Getenv("LLM_DETECTOR_LOCAL_ORIGINS"), "allowed page origins, comma separated")
	flag.Parse()
	cache, err := os.UserCacheDir()
	if err != nil {
		log.Fatal("cannot locate user cache")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	origins := strings.FieldsFunc(*originsFlag, func(r rune) bool { return r == ',' || r == ';' || r == ' ' })
	local, err := localruntime.New(ctx, filepath.Join(cache, "llm-detector", "runtime"), origins...)
	if err != nil {
		log.Fatal(err)
	}
	defer func() {
		stop()
		if err := local.Close(); err != nil {
			log.Print("local temporary directory cleanup failed")
		}
	}()
	server := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", *port), Handler: local, ReadHeaderTimeout: 5 * time.Second}
	if len(origins) == 0 {
		origins = []string{"http://127.0.0.1:9000", "http://localhost:9000"}
	}
	fmt.Printf("LLM Detector 本机执行器\n地址: http://%s\n已允许页面来源: %s\n请在网页点击“连接本机执行器”。关闭此程序会停止本机任务。\n", server.Addr, strings.Join(origins, ", "))
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	select {
	case err := <-done:
		if err != http.ErrServerClosed {
			log.Print(err)
		}
	case <-ctx.Done():
	}
	timeout, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(timeout)
}
