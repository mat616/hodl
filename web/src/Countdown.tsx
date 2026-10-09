import { useEffect, useState } from "react";
import { clock, remainingSeconds } from "./api";

export function Countdown({
  secondsLeft,
  serverNow,
}: {
  secondsLeft: number | null;
  serverNow?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return <>{clock(remainingSeconds(secondsLeft, serverNow, now))}</>;
}
