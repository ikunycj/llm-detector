package cloud

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

type Database struct {
	sql    *sql.DB
	cipher cipher.AEAD
}

func Open(dir string) (*Database, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "cloud.sqlite")
	keyPath := filepath.Join(dir, "cloud.key")
	key, err := os.ReadFile(keyPath)
	if errors.Is(err, os.ErrNotExist) {
		if _, dbErr := os.Stat(path); !errors.Is(dbErr, os.ErrNotExist) {
			return nil, errors.New("cloud.key 缺失，请恢复数据库对应的密钥")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		_, writeErr := f.Write(key)
		closeErr := f.Close()
		if err = errors.Join(writeErr, closeErr); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("cloud.key 必须是有效的 AES 密钥")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;" + schema); err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		db.Close()
		return nil, err
	}
	return &Database{sql: db, cipher: aead}, nil
}
func (d *Database) Close() error { return d.sql.Close() }
func (d *Database) Put(userID int64, kind, id string, plain []byte) error {
	nonce := make([]byte, d.cipher.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	data := d.cipher.Seal(nonce, nonce, plain, []byte(strconv.FormatInt(userID, 10)+":"+kind+":"+id))
	_, err := d.sql.Exec("INSERT INTO documents(user_id,kind,id,payload) VALUES(?,?,?,?) ON CONFLICT(user_id,kind,id) DO UPDATE SET payload=excluded.payload", userID, kind, id, data)
	return err
}
func (d *Database) Get(userID int64, kind, id string) ([]byte, error) {
	var data []byte
	if err := d.sql.QueryRow("SELECT payload FROM documents WHERE user_id=? AND kind=? AND id=?", userID, kind, id).Scan(&data); err != nil {
		return nil, err
	}
	return d.decrypt(userID, data, kind, id)
}
func (d *Database) decrypt(userID int64, data []byte, kind, id string) ([]byte, error) {
	n := d.cipher.NonceSize()
	if len(data) < n {
		return nil, errors.New("云端数据损坏")
	}
	return d.cipher.Open(nil, data[:n], data[n:], []byte(strconv.FormatInt(userID, 10)+":"+kind+":"+id))
}
func (d *Database) List(userID int64, kind string) ([][]byte, error) {
	records, err := d.Records(userID, kind)
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(records))
	for _, record := range records {
		out = append(out, record.Data)
	}
	return out, nil
}

type Record struct {
	ID   string
	Data []byte
}

func (d *Database) Records(userID int64, kind string) ([]Record, error) {
	rows, err := d.sql.Query("SELECT id,payload FROM documents WHERE user_id=? AND kind=? ORDER BY id", userID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		data, err := d.decrypt(userID, raw, kind, id)
		if err != nil {
			return nil, err
		}
		out = append(out, Record{ID: id, Data: data})
	}
	return out, rows.Err()
}

func (d *Database) Delete(userID int64, kind, id string) error {
	_, err := d.sql.Exec("DELETE FROM documents WHERE user_id=? AND kind=? AND id=?", userID, kind, id)
	return err
}
