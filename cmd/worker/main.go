package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"llm-detector/internal/cloud"
	"llm-detector/internal/config"
	"llm-detector/internal/localruntime"
	"llm-detector/internal/worker"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	envFile := flag.String("env", "worker.env", "Worker environment file")
	flag.Parse()
	values, err := godotenv.Read(*envFile)
	if errors.Is(err, os.ErrNotExist) {
		key := make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return err
		}
		values = map[string]string{"WORKER_KEY": hex.EncodeToString(key), "HTTP_ADDR": "127.0.0.1:9003", "DATA_DIR": "worker-data", "WORKER_ORIGINS": "http://127.0.0.1:9000,http://localhost:9000"}
		text := "WORKER_KEY=" + values["WORKER_KEY"] + "\nHTTP_ADDR=" + values["HTTP_ADDR"] + "\nDATA_DIR=" + values["DATA_DIR"] + "\nWORKER_ORIGINS=" + values["WORKER_ORIGINS"] + "\n"
		if err = os.WriteFile(*envFile, []byte(text), 0600); err != nil {
			return err
		}
		fmt.Println("Worker 配置已创建；请从", *envFile, "复制 WORKER_KEY 到网页。")
	} else if err != nil {
		return errors.New("无法读取 worker.env，请检查格式")
	}
	value := func(k, fallback string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		if v := values[k]; v != "" {
			return v
		}
		return fallback
	}
	data := value("DATA_DIR", "worker-data")
	deps := filepath.Join(data, "runtime")
	cfg := config.Config{DataDir: data, Addr: value("HTTP_ADDR", "127.0.0.1:9003"), SessionTTL: 24 * time.Hour, RequestTimeout: 30 * time.Second, FingerprintRequestTimeout: 120 * time.Second, TerminalBenchBinary: value("TERMINAL_BENCH_BINARY", localruntime.HarborBinary(deps)), FingerprintCachePath: filepath.Join(data, "fingerprint-cache")}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := cloud.Open(data)
	if err != nil {
		return err
	}
	defer db.Close()
	handler, err := worker.New(ctx, cfg, db, value("WORKER_KEY", ""), strings.Split(value("WORKER_ORIGINS", "http://127.0.0.1:9000,http://localhost:9000"), ","), deps)
	if err != nil {
		return err
	}
	defer func() { stop(); handler.Wait() }()
	server := &http.Server{Addr: cfg.Addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 4*time.Minute + 5*time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan error, 1)
	go func() { log.Printf("Worker listening on %s; data=%s", cfg.Addr, data); done <- server.ListenAndServe() }()
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}
