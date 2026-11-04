-- 002: penguncian akun setelah salah PIN; trigger users tidak menaikkan
-- server_version saat login (agar login tidak membanjiri sinkronisasi).
ALTER TABLE users
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until  timestamptz;

CREATE UNIQUE INDEX uq_users_username_lower ON users (lower(username)) WHERE deleted_at IS NULL;

DROP TRIGGER trg_touch ON users;
CREATE TRIGGER trg_touch
  BEFORE INSERT OR UPDATE OF username, full_name, role, is_active, deleted_at
  ON users FOR EACH ROW EXECUTE FUNCTION touch_row();
