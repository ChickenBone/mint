import { hash, verify } from "@node-rs/argon2";
import type { AccountAuthenticationPasswords } from "./authenticate-account";

export const argon2Passwords: AccountAuthenticationPasswords = {
  hash: (password) => hash(password),
  verify: (passwordHash, password) => verify(passwordHash, password),
};
