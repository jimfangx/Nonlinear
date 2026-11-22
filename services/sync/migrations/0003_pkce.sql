-- Desktop loopback OAuth (RFC 8252) with PKCE on the one-time login code.
ALTER TABLE oauth_states ADD COLUMN code_challenge TEXT;
ALTER TABLE oauth_states ADD COLUMN client_state TEXT;
ALTER TABLE login_codes ADD COLUMN code_challenge TEXT;
