export interface PasswordState {
  has_password: boolean;
  needs_password_setup: boolean;
}

interface PasswordStateSource {
  password_hash: string;
  provider?: string | null;
}

export function getPasswordState({
  password_hash,
  provider,
}: PasswordStateSource): PasswordState {
  const hasPassword = password_hash.length > 0;

  return {
    has_password: hasPassword,
    needs_password_setup: Boolean(provider && !hasPassword),
  };
}

export function toSafeUser<T extends PasswordStateSource>(
  user: T
): Omit<T, "password_hash"> & PasswordState {
  const { password_hash, ...safeUser } = user;

  return {
    ...safeUser,
    ...getPasswordState({ password_hash, provider: user.provider }),
  };
}
