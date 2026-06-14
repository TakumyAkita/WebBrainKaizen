# BrainKaizen

Produtividade inteligente para estudantes — Timer Pomodoro, gestão de tarefas, notas e acompanhamento de sono, tudo em um PWA leve e offline-first.

🔗 **Demo:** [brainkaizen.netlify.app](https://brainkaizen.netlify.app)

## Funcionalidades

- ⏱️ **Timer Pomodoro** — sessões de foco e descanso configuráveis
- ✅ **Gestão de tarefas** — tags com hashtags, subtarefas e recorrência
- 📓 **Notas** — múltiplos cadernos com editor de texto rico (Quill.js)
- 😴 **Acompanhamento de sono** — registro e visualização de padrões
- 📊 **Estatísticas** — gráficos de produtividade (Chart.js)
- 🎨 **4 temas** — visual em glassmorphism, com tema padrão em tons terrosos
- 📱 **PWA** — instalável, funciona offline e sincroniza entre dispositivos

## Tecnologias

- HTML, CSS e JavaScript puro (sem frameworks)
- [Supabase](https://supabase.com/) — autenticação e armazenamento em nuvem
- [Chart.js](https://www.chartjs.org/) — gráficos e estatísticas
- [Quill.js](https://quilljs.com/) — editor de texto rico
- [localForage](https://localforage.github.io/localForage/) — cache offline (IndexedDB)
- [SortableJS](https://sortablejs.github.io/Sortable/) — drag and drop de tarefas
- Deploy via [Netlify](https://www.netlify.com/)

## Arquitetura

O app segue uma abordagem **offline-first**:

- Os dados ficam em cache local via `localForage` (IndexedDB), garantindo uso sem internet.
- O Supabase atua como fonte de verdade na nuvem, com sincronização em tempo real (Realtime) entre dispositivos.
- Estratégia de resolução de conflitos: **Last Write Wins**.

## Como rodar localmente

1. Clone o repositório:
   ```bash
   git clone https://github.com/SEU_USUARIO/brainkaizen.git
   cd brainkaizen
   ```

2. Configure o Supabase:
   - Copie `config.example.js` para `config.js`
   - Em [Supabase](https://supabase.com/), crie um projeto e vá em **Project Settings → API**
   - Preencha `SUPABASE_URL` e `SUPABASE_KEY` (anon public key) em `config.js`

3. Crie a tabela necessária no Supabase (SQL Editor):
   ```sql
   create table user_data (
     user_id uuid primary key references auth.users(id) on delete cascade,
     data jsonb
   );
   ```

4. Sirva os arquivos com qualquer servidor estático, por exemplo:
   ```bash
   npx serve .
   ```

## Licença

Projeto pessoal para fins de estudo e portfólio.
