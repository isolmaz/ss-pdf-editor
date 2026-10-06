/**
 * A box that holds a picture of a known shape at the largest size that fits its parent,
 * centred — what `object-fit: contain` does for the picture, but with the picture's
 * rectangle known, so the outline and the corner handles drawn over it can be positioned
 * by percentages of the picture itself.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface FittedStageProps {
  /** Width over height of the picture. */
  readonly aspect: number;
  readonly className?: string;
  readonly children: ReactNode;
}

export function FittedStage({ aspect, className, children }: FittedStageProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ readonly width: number; readonly height: number }>({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const measure = () => {
      const { clientWidth, clientHeight } = element;
      const width = Math.min(clientWidth, clientHeight * aspect);
      setBox({ width, height: width / aspect });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [aspect]);

  return (
    <div ref={holder} className={`relative flex items-center justify-center ${className ?? ''}`}>
      <div className="relative shrink-0" style={{ width: box.width, height: box.height }}>
        {children}
      </div>
    </div>
  );
}
