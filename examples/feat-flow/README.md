# Example: Feature branch flow

Este é um exemplo canônico do artefato produzido por:

```bash
archify flow --git-range=origin/main...HEAD --out=docs/flows/
```

A entrada é uma branch de feature fictícia (`feat`) com dois commits e
duas modificações de arquivo (um endpoint de usuários e seu changelog).
O artefato mostra o workflow como três lanes (`Modify`, `Decide`,
`Validate`) conectados fim-a-fim pelo `mainPath`. Não há nós sintéticos
de início/fim: o `mainPath` carrega a ordem da primeira modificação
até a última decisão, atravessando os commits via lane `Decide`.

Esta fixture populou apenas duas das três lanes (Modify + Decide). Em
fixtures com validações explícitas (via `--validations`) o lane
`Validate` também recebe nós. O número de nós do exemplo é 4
(`mainPath.length === 4`).

Abra `workflow.html` no navegador para a experiência interativa ou
inspecione `workflow.json` para a fonte tipada.
