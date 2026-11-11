package cloud

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}
type passwordHash struct {
	Salt []byte `json:"salt"`
	Hash []byte `json:"hash"`
}

var ErrCredentials = errors.New("账号或密码不正确")

func passwordKey(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, 2, 19*1024, 1, 32)
}
func (d *Database) CreateUser(username, password string) (User, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if utf8.RuneCountInString(username) < 3 || len(username) > 128 || strings.ContainsAny(username, "\r\n\x00") || len(password) == 0 || len(password) > 256 {
		return User{}, errors.New("账号至少 3 个字符，密码不能为空且不超过 256 字节")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return User{}, err
	}
	encoded, err := json.Marshal(passwordHash{Salt: salt, Hash: passwordKey(password, salt)})
	if err != nil {
		return User{}, err
	}
	result, err := d.sql.Exec("INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)", username, string(encoded), time.Now().Unix())
	if err != nil {
		return User{}, errors.New("账号创建失败，请确认账号没有重复")
	}
	id, err := result.LastInsertId()
	return User{ID: id, Username: username}, err
}
func (d *Database) Users() ([]User, error) {
	rows, err := d.sql.Query("SELECT id,username FROM users ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Username); err != nil {
			return nil, err
		}
		out = append(out, user)
	}
	return out, rows.Err()
}
func (d *Database) Login(username, password string, ttl time.Duration) (User, string, time.Time, error) {
	var user User
	var encoded string
	err := d.sql.QueryRow("SELECT id,username,password_hash FROM users WHERE username=?", strings.ToLower(strings.TrimSpace(username))).Scan(&user.ID, &user.Username, &encoded)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return User{}, "", time.Time{}, err
	}
	stored := passwordHash{Salt: make([]byte, 16), Hash: make([]byte, 32)}
	if err == nil {
		if json.Unmarshal([]byte(encoded), &stored) != nil {
			return User{}, "", time.Time{}, errors.New("账号数据损坏")
		}
	}
	candidate := passwordKey(password, stored.Salt)
	if subtle.ConstantTimeCompare(candidate, stored.Hash) != 1 || user.ID == 0 {
		return User{}, "", time.Time{}, ErrCredentials
	}
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return User{}, "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes)
	hash := sha256.Sum256([]byte(token))
	expires := time.Now().Add(ttl)
	tx, err := d.sql.Begin()
	if err != nil {
		return User{}, "", time.Time{}, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("DELETE FROM sessions WHERE expires_at<=?", time.Now().Unix()); err != nil {
		return User{}, "", time.Time{}, err
	}
	if _, err = tx.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", hash[:], user.ID, expires.Unix()); err != nil {
		return User{}, "", time.Time{}, err
	}
	if err = tx.Commit(); err != nil {
		return User{}, "", time.Time{}, err
	}
	return user, token, expires, nil
}
func (d *Database) Authenticate(header string) (User, error) {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return User{}, ErrCredentials
	}
	hash := sha256.Sum256([]byte(token))
	var user User
	err := d.sql.QueryRow("SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?", hash[:], time.Now().Unix()).Scan(&user.ID, &user.Username)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrCredentials
	}
	return user, err
}
func (d *Database) Logout(header string) error {
	token, _ := strings.CutPrefix(header, "Bearer ")
	hash := sha256.Sum256([]byte(token))
	_, err := d.sql.Exec("DELETE FROM sessions WHERE token_hash=?", hash[:])
	return err
}
