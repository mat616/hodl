import { PublicKey, Transaction } from "@solana/web3.js";
import { type TxSigner } from "./chain";

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PublicKey | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  disconnect: () => Promise<void>;
};

function provider(): PhantomProvider | null {
  const win = window as unknown as { phantom?: { solana?: PhantomProvider } };
  const sol = win.phantom?.solana;
  return sol?.isPhantom ? sol : null;
}

export function phantomInstalled(): boolean {
  return provider() !== null;
}

export async function connectPhantom(onlyIfTrusted = false): Promise<TxSigner> {
  const phantom = provider();
  if (!phantom) throw new Error("Install Phantom, then refresh this page.");
  const res = await phantom.connect(onlyIfTrusted ? { onlyIfTrusted: true } : undefined);
  const owner = res.publicKey;
  return {
    publicKey: owner,
    sign: (tx) => phantom.signTransaction(tx),
  };
}

export async function disconnectPhantom() {
  const phantom = provider();
  if (phantom) await phantom.disconnect();
}
