package inspection

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// FileStore is owned by Service, which serializes writes under its mutex.
// Initial creation and upgrades use the same versioned document path.
type FileStore struct {
	file string
	aead cipher.AEAD
}

func OpenStore(dir string) (*FileStore, state, error) {
	empty := state{Version: 1, Projects: map[string]diskProject{}, Runs: []Run{}}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, empty, err
	}
	keyFile := filepath.Join(dir, "inspection.key")
	dataFile := filepath.Join(dir, "inspections.enc")
	key, err := os.ReadFile(keyFile)
	if errors.Is(err, os.ErrNotExist) {
		if _, statErr := os.Stat(dataFile); !errors.Is(statErr, os.ErrNotExist) {
			return nil, empty, errors.New("巡检加密文件存在但 inspection.key 缺失，请恢复原密钥")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, empty, err
		}
		f, err := os.OpenFile(keyFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, empty, err
		}
		_, writeErr := f.Write(key)
		syncErr := f.Sync()
		closeErr := f.Close()
		if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
			return nil, empty, err
		}
	} else if err != nil {
		return nil, empty, err
	}
	if len(key) != 32 {
		return nil, empty, errors.New("inspection.key 必须是 32 字节")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, empty, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, empty, err
	}
	store := &FileStore{file: dataFile, aead: aead}
	data, err := os.ReadFile(dataFile)
	if errors.Is(err, os.ErrNotExist) {
		return store, empty, nil
	}
	if err != nil {
		return nil, empty, err
	}
	if len(data) < aead.NonceSize() {
		return nil, empty, errors.New("巡检存储文件损坏")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte("llm-detector/inspections/v1"))
	if err != nil {
		return nil, empty, errors.New("无法解密巡检存储，请检查原密钥和文件完整性")
	}
	if json.Unmarshal(plain, &empty) != nil || empty.Version != 1 || empty.Projects == nil {
		return nil, empty, errors.New("巡检存储 schema 不兼容或损坏")
	}
	return store, empty, nil
}

func (s *FileStore) Save(data state) error {
	plain, err := json.Marshal(data)
	if err != nil {
		return err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	sealed := s.aead.Seal(nonce, nonce, plain, []byte("llm-detector/inspections/v1"))
	f, err := os.CreateTemp(filepath.Dir(s.file), ".inspections-*")
	if err != nil {
		return fmt.Errorf("创建巡检存储临时文件失败: %w", err)
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(sealed)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return fmt.Errorf("写入巡检存储失败: %w", err)
	}
	if err = os.Rename(f.Name(), s.file); err != nil {
		return fmt.Errorf("保存巡检存储失败: %w", err)
	}
	return nil
}
