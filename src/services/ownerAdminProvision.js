// Owner-requested one-time credential change. Only the server stores the verifier.
// Keep the provision version across later password resets so they are not undone.
export const ownerAdminProvision = {
  "email": "khanfaizan3234@gmail.com",
  "version": "owner-2026-09-22",
  "record": {
    "algorithm": "pbkdf2",
    "salt": "c261bc2256169e0ff72f5de8bccf89a3",
    "iterations": 100000,
    "keyLen": 64,
    "digest": "sha512",
    "hash": "e7ea8633cf5496fa499c2fcb38c953787b0f4072ab9fad0984b91964f61949fa02c12a18d9ec3e673589fbf69af7aadf773a8503f0b17d43eff11ee3304595cc"
  }
};
