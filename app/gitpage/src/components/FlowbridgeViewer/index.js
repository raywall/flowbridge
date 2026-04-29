import React, { useEffect, useRef } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function FlowbridgeViewer({ src, height = 520 }) {
  return (
    <BrowserOnly fallback={<div>Carregando diagrama...</div>}>
      {() => {
        // Renderizado apenas no cliente
        const Viewer = () => {
          const containerRef = useRef(null);

          useEffect(() => {
            let isMounted = true;

            async function bootstrap() {
              // Espera até que o Docusaurus carregue os scripts globais no window
              while ((!window.mermaid || !window.Flowbridge) && isMounted) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }

              if (isMounted && containerRef.current && window.Flowbridge) {
                containerRef.current.innerHTML = ''; // Limpa o container
                
                const viewer = new window.Flowbridge.Viewer({
                  element: containerRef.current,
                  initialSrc: src,
                  height: height,
                });
                
                await viewer.start();
              }
            }

            bootstrap();

            return () => {
              isMounted = false; // Cleanup ao desmontar a página
            };
          }, [src, height]);

          return (
            <div 
              ref={containerRef} 
              style={{ width: '100%', minHeight: height }}
            ></div>
          );
        };

        return <Viewer />;
      }}
    </BrowserOnly>
  );
}