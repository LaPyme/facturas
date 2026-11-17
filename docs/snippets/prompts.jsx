// The prompts on the home page and the quickstart. The package docs build,
// packages/arca/scripts/build-docs.mjs, reads these constants to write the
// same text into the Markdown copy of the quickstart.
// Mintlify provides the React hooks to snippets as globals.
export const setupPrompt = `Configurá facturas en este proyecto para emitir comprobantes electrónicos con ARCA en homologación. Requiere Node.js 22 o posterior y ESM.

1. Instalá facturas con el gestor de paquetes del proyecto. Si una política de antigüedad de versiones bloquea la instalación, frená y preguntame en vez de cambiarla.
2. Agregá una nota en AGENTS.md, creándolo si hace falta: antes de usar facturas, seguí la skill facturas si está instalada y leé node_modules/facturas/docs/llms.txt. Los tipos en node_modules/facturas/dist/ son la verdad para la versión instalada.
3. Si soportás skills, corré: npx skills add LaPyme/facturas
4. Preguntame el CUIT del emisor. Con ese CUIT, corré npx facturas init --cuit CUIT --env test --no-paste y pasame los pasos que imprime. El certificado se pide en ARCA con mi clave fiscal, eso lo hago yo. Esperá a que te avise que guardé arca-test.crt.
5. Corré npx facturas check. Si falla, decime qué paso nombra y dónde se corrige en ARCA.
6. Cargá ARCA_TAX_ID, ARCA_ENVIRONMENT=test, ARCA_CERTIFICATE_PEM y ARCA_PRIVATE_KEY_PEM en el archivo de entorno local del proyecto, ignorado por git. Copiá los PEM desde arca-test.crt y arca-test.key con un comando, sin mostrarlos.
7. No imprimas ni subas al repositorio la clave privada. No uses ARCA_ENVIRONMENT=production.
8. Corré el typecheck del proyecto.

Cuando termines, preguntame qué querés facturar.`;

export const firstInvoicePrompt = `Emití una factura de prueba en homologación con facturas. Preguntame la condición fiscal del emisor y el punto de venta. No los infieras.

1. Armá el input con un importe chico y mostrame preview(input).amounts.sentTotal antes de emitir.
2. Emití con issue() y tratá los cuatro resultados: authorized, rejected, indeterminate y conflict.
3. Escribí tests para los cuatro resultados. Corré el typecheck y los tests.

Decime qué pasó, el CAE si ARCA lo autorizó y qué no pudiste probar.`;

export const PromptText = ({ label, prompt }) => {
  const text = useRef(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Without clipboard access, select the text so it can be copied by hand.
      window.getSelection()?.selectAllChildren(text.current);
    }
  };

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border border-gray-950/10 dark:border-white/10">
      <div className="flex items-center justify-between gap-4 border-gray-950/10 border-b bg-gray-50 px-4 py-2 dark:border-white/10 dark:bg-white/5">
        <span className="text-gray-600 text-sm dark:text-gray-400">
          {label}
        </span>
        <button
          className="cursor-pointer rounded-md bg-primary px-3 py-1 font-medium text-white text-xs hover:opacity-90 dark:bg-primary-light dark:text-gray-900"
          onClick={copy}
          type="button"
        >
          {copied ? "Copiado" : "Copiar prompt"}
        </button>
      </div>
      <pre
        className="m-0 overflow-y-auto whitespace-pre-wrap bg-white p-4 font-mono text-gray-800 text-xs leading-relaxed dark:bg-transparent dark:text-gray-200"
        ref={text}
        style={{ maxHeight: "50vh" }}
      >
        {prompt}
      </pre>
    </div>
  );
};

export const SetupPromptDialog = () => {
  const dialog = useRef(null);
  const open = () => dialog.current?.showModal();
  const close = () => dialog.current?.close();

  return (
    <>
      <button
        className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-5 py-2.5 font-medium text-sm text-white hover:opacity-90 dark:bg-primary-light dark:text-gray-900"
        onClick={open}
        type="button"
      >
        Copiar prompt
      </button>
      <dialog
        aria-labelledby="setup-prompt-title"
        className="m-auto w-full max-w-2xl rounded-2xl border border-gray-950/10 bg-white p-6 text-left backdrop:bg-black/50 dark:border-white/10 dark:bg-gray-900"
        ref={dialog}
        style={{ boxShadow: "0 24px 64px -16px rgb(0 0 0 / 0.4)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              className="font-semibold text-gray-900 text-lg dark:text-white"
              id="setup-prompt-title"
            >
              Copiar prompt
            </h2>
            <p className="mt-1 text-gray-600 text-sm dark:text-gray-400">
              Pegalo en tu agente de código. Configura facturas en homologación
              y te espera en el paso que hacés vos en ARCA.
            </p>
          </div>
          <button
            aria-label="Cerrar"
            className="shrink-0 cursor-pointer rounded-md p-1 text-gray-500 hover:text-gray-900 dark:hover:text-white"
            onClick={close}
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="18"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="18"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <PromptText label="Prompt" prompt={setupPrompt} />
        <div className="flex justify-end">
          <button
            className="cursor-pointer rounded-full border border-gray-950/10 px-4 py-2 font-medium text-gray-900 text-sm hover:bg-gray-950/5 dark:border-white/15 dark:text-white dark:hover:bg-white/5"
            onClick={close}
            type="button"
          >
            Cerrar
          </button>
        </div>
      </dialog>
    </>
  );
};
