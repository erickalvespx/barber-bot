require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// 🌐 CONEXÃO COM O SUPABASE
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 🌐 CONFIGURAÇÃO DO SERVIDOR WEBHOOK (EXPRESS)
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// 🛠️ PLANO B: Versão Congelada do WhatsApp Web
const client = new Client({ 
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const userStates = {};
let ultimaLimpezaDiaria = null; // TRAVA DE SEGURANÇA PARA A LIMPEZA DA MEIA-NOITE

// ⏱️ FUNÇÃO AUXILIAR DE DELAY
const delay = ms => new Promise(res => setTimeout(res, ms));

// 📅 FUNÇÃO AUXILIAR PARA GERAR DATAS FORMATADAS (AAAA-MM-DD) BLINDADA CONTRA FUSO
function obterDataFormatada(diasAmais = 0) {
    const dataAlvo = new Date(Date.now() + (diasAmais * 86400000));
    return dataAlvo.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// 🛠️ FUNÇÃO AUXILIAR: GERAÇÃO SOB DEMANDA DE HORÁRIOS
async function garantirHorariosDoDia(dataEscolhida, diaDaSemana) {
    const { data: registrosExistentes, error: erroBusca } = await supabase
        .from('Disponibilidade')
        .select('*')
        .eq('Data', dataEscolhida)
        .order('Horário', { ascending: true });

    if (erroBusca) {
        console.error('Erro ao buscar horários:', erroBusca);
        return [];
    }

    if (registrosExistentes && registrosExistentes.length > 0) {
        return registrosExistentes;
    }

    console.log(`[Sistema] Gerando horários sob demanda para a data ${dataEscolhida}...`);
    
    let horariosPadrao = [];
    if (diaDaSemana >= 1 && diaDaSemana <= 5) { 
        horariosPadrao = [
            '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
            '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'
        ];
    } else if (diaDaSemana === 6) { 
        horariosPadrao = [
            '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
            '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'
        ];
    } else {
        return [];
    }

    const novosRegistros = horariosPadrao.map(hora => ({
        "Horário": hora,
        "Status": "Livre",
        "Data": dataEscolhida
    }));

    const { data: registrosInseridos, error: erroInsert } = await supabase
        .from('Disponibilidade')
        .insert(novosRegistros)
        .select()
        .order('Horário', { ascending: true });

    if (erroInsert) {
        console.error('Erro ao injetar horários sob demanda:', erroInsert);
        return [];
    }

    return registrosInseridos;
}

// 🤖 FUNÇÕES DE DIGITAÇÃO
async function responderComDigitando(chat, msg, texto) {
    await chat.sendStateTyping();
    await delay(1000); 
    return msg.reply(texto);
}

async function enviarComDigitando(chat, texto) {
    await chat.sendStateTyping();
    await delay(1000); 
    return chat.sendMessage(texto);
}

// ⏰ FUNÇÃO SEGUNDO PLANO (LEMBRETES DE AGENDAMENTO)
async function verificarEDispararLembretes() {
    try {
        console.log('🔍 [Sistema] Verificando se há lembretes para enviar...');
        const dataHojeStr = obterDataFormatada(0);
        
        const { data: registros, error } = await supabase
            .from('Agendamentos')
            .select('*')
            .eq('Status', 'Agendado')
            .eq('Data', dataHojeStr)
            .eq('Lembrete', false);

        if (error) throw error;
        if (!registros) return;

        const agora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        for (const reg of registros) {
            const horarioStr = reg.Horário;
            const telefoneCliente = reg.Telefone;
            const nomeCliente = reg.Nome;
            const servicoCliente = reg.Serviço;

            if (!horarioStr || !telefoneCliente) continue;
            const [horas, minutos] = horarioStr.split(':').map(Number);
            const dataAgendamento = new Date(agora);
            dataAgendamento.setHours(horas, minutos, 0, 0);

            const diferencaEmMilissegundos = dataAgendamento - agora;
            const diferencaEmMinutos = Math.round(diferencaEmMilissegundos / 60000);

            if (diferencaEmMinutos > 0 && diferencaEmMinutos <= 60) {
                console.log(`📢 Enviando lembrete para ${nomeCliente} - Horário: ${horarioStr}`);
                try {
                    const chat = await client.getChatById(telefoneCliente);
                    await chat.sendStateTyping();
                    await delay(1000);
                    await client.sendMessage(telefoneCliente, `⏰ *Lembrete de Agendamento!* \n\nFala, ${nomeCliente}! Passando para lembrar que o seu horário de *${servicoCliente}* é daqui a pouco, às *${horarioStr}*.\n\nEstamos te esperando! 💈👊`);
                    await supabase.from('Agendamentos').update({ Lembrete: true }).eq('id', reg.id);
                } catch (err) {
                    console.error(`❌ Erro ao enviar lembrete para ${nomeCliente}:`, err.message);
                }
                await delay(2000);
            }
        }
    } catch (error) {
        console.error('❌ Erro na rotina de lembretes:', error);
    }
}

// ⏳ FUNÇÃO SEGUNDO PLANO (EXPIRAÇÃO DE PIX/CARTÃO NÃO PAGOS)
async function verificarEExpirarPagamentos() {
    try {
        console.log('🔍 [Sistema] Verificando se há pagamentos pendentes expirados...');
        const { data: pendentes, error } = await supabase
            .from('Agendamentos')
            .select('*')
            .eq('Status', 'Aguardando Pagamento');

        if (error) throw error;
        if (!pendentes) return;

        const registrosExpirados = pendentes.filter(reg => {
            const createdAt = new Date(reg.created_at).getTime();
            const agora = Date.now();
            return ((agora - createdAt) / 60000) > 10;
        });

        for (const reg of registrosExpirados) {
            console.log(`⏳ [Limpeza] Expirando agendamento de ${reg.Nome} (${reg.Horário}) por falta de pagamento.`);
            await supabase.from('Disponibilidade').update({ Status: 'Livre' }).eq('Horário', reg.Horário).eq('Data', reg.Data);
            await supabase.from('Agendamentos').update({ Status: 'Cancelado' }).eq('id', reg.id);
            if (reg.Telefone) {
                try {
                    const chat = await client.getChatById(reg.Telefone);
                    await chat.sendStateTyping();
                    await delay(1000);
                    await client.sendMessage(reg.Telefone, `⚠️ *Tempo Limite Expirado!*\n\nFala, ${reg.Nome}. Como o pagamento do Pix/Cartão não foi realizado nos últimos 10 minutos, o seu horário das *${reg.Horário}* foi cancelado automaticamente para liberar a vaga para outros clientes.\n\nCaso ainda queira realizar o serviço, basta mandar um *"Oi"* para reiniciar e escolher um novo horário! 💈👊`);
                } catch (errWpp) {
                    console.error('Erro ao enviar mensagem de expiração:', errWpp);
                }
            }
            await delay(2000);
        }
    } catch (error) {
        console.error('❌ Erro na rotina de expiração de pagamentos:', error);
    }
}

// 💸 FUNÇÃO SEGUNDO PLANO (COBRANÇA DE MENSALIDADES)
async function cobrarMensalidades() {
    try {
        console.log('🔍 [Sistema] Verificando vencimento de mensalidades dos barbeiros...');
        const { data: registros, error } = await supabase
            .from('Barbeiros')
            .select('*')
            .in('Status', ['Pago', 'Pendente']);

        if (error) throw error;
        if (!registros) return;

        const agora = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        for (const reg of registros) {
            const dataVencimentoStr = reg.Data_Vencimento;
            if (!dataVencimentoStr) continue;

            const [ano, mes, dia] = dataVencimentoStr.split('T')[0].split('-');
            const dataVencimento = new Date(ano, mes - 1, dia);
            dataVencimento.setHours(0,0,0,0);
            const hoje = new Date(agora);
            hoje.setHours(0,0,0,0);

            const diffTime = dataVencimento - hoje;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            const telefone = reg.Telefone;
            const nome = reg.Nome;
            const etapa = reg.Etapa_Cobranca || 'Nenhum';
            const chavePix = "88992135659";

            try {
                if (diffDays === 3 && etapa !== 'Aviso 3 Days') {
                    await client.sendMessage(telefone, `Fala, ${nome}! Passando para lembrar que faltam 3 dias para o vencimento da sua mensalidade (R$ 177,00).\n\nQuando puder, é só enviar para a chave Pix: *${chavePix}* e me mandar o comprovante aqui! 💈`);
                    await supabase.from('Barbeiros').update({ Etapa_Cobranca: 'Aviso 3 Days' }).eq('id', reg.id);
                } 
                else if (diffDays === 0 && etapa !== 'Aviso Vencimento') {
                    await client.sendMessage(telefone, `Fala, ${nome}! Hoje é o dia do vencimento da sua mensalidade de R$ 177,00.\n\nSegue a chave Pix: *${chavePix}*. Assim que transferir, manda o comprovante pra gente dar baixa no sistema! 💈👊`);
                    await supabase.from('Barbeiros').update({ Etapa_Cobranca: 'Aviso Vencimento' }).eq('id', reg.id);
                }
                else if (diffDays < 0 && diffDays >= -3 && etapa !== 'Atrasado' && reg.Status === 'Pendente') {
                    await client.sendMessage(telefone, `⚠️ *Aviso de Atraso*\n\nFala, ${nome}. Identificamos que a sua mensalidade está pendente há ${Math.abs(diffDays)} dia(s).\n\nPara mantermos a parceria em dia, por favor, regularize o pagamento de R$ 177,00 na chave Pix: *${chavePix}*.`);
                    await supabase.from('Barbeiros').update({ Etapa_Cobranca: 'Atrasado' }).eq('id', reg.id);
                }
            } catch (err) {
                console.error(`❌ Erro ao enviar cobrança para ${nome}:`, err.message);
            }
            await delay(2000);
        }
    } catch (error) {
        console.error('❌ Erro na rotina de cobrança:', error);
    }
}

// 🧹 FUNÇÃO SEGUNDO PLANO (RESET E LIMPEZA DIÁRIA CIRÚRGICA BLINDADA)
async function resetarHorariosDiarios() {
    try {
        // Captura a hora exata de Brasília independente de onde o servidor esteja hospedado
        const agora = new Date();
        const fusoBrasilia = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const horaAtualBrasil = fusoBrasilia.getHours(); 
        
        const dataHojeStr = obterDataFormatada(0);

        // Impede que a limpeza rode mais de uma vez no mesmo dia
        if (ultimaLimpezaDiaria === dataHojeStr) return;

        // Se for entre 00:00 e 00:59 (Janela da Meia-Noite)
        if (horaAtualBrasil === 0) {
            console.log(`🧹 [Sistema] Meia-noite detectada (${fusoBrasilia.toLocaleTimeString('pt-BR')})! Executando limpeza profunda...`);
            
            // Ativa a trava IMEDIATAMENTE para evitar que o próximo ciclo de 10min concorra se a query demorar
            ultimaLimpezaDiaria = dataHojeStr;

            // 1. DELETA horários da tabela Disponibilidade de dias que já passaram
            const { error: errDisp } = await supabase
                .from('Disponibilidade')
                .delete()
                .lt('Data', dataHojeStr);

            // 2. DELETA os agendamentos de dias que já passaram (Mantém o banco leve)
            const { error: errAgend } = await supabase
                .from('Agendamentos')
                .delete()
                .lt('Data', dataHojeStr);

            if (errDisp) {
                console.error('❌ Erro na limpeza da Disponibilidade:', errDisp);
                ultimaLimpezaDiaria = null; // Desfaz a trava para tentar de novo no próximo ciclo de 10min
                return;
            }
            
            if (errAgend) {
                console.error('❌ Erro na limpeza dos Agendamentos:', errAgend);
                ultimaLimpezaDiaria = null; // Desfaz a trava para tentar de novo no próximo ciclo de 10min
                return;
            }

            console.log('✅ [Sistema] Limpeza de dias anteriores e otimização concluídas com sucesso!');
        }
    } catch (error) {
        console.error('❌ Erro crítico ao resetar horários diários:', error);
        ultimaLimpezaDiaria = null; // Garante que não vai travar desligado se falhar catastroficamente
    }
}

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
    console.log('BarberSync: Sistema de Lembretes, Mensalidades e Limpeza Ativado! ⏰🛡️💈');
    
    verificarEDispararLembretes();
    verificarEExpirarPagamentos();
    cobrarMensalidades();
    resetarHorariosDiarios();
    
    // ⏱️ A CADA 10 MINUTOS (600.000 ms)
    setInterval(() => {
        verificarEDispararLembretes();
        verificarEExpirarPagamentos();
        resetarHorariosDiarios(); // Agora a verificação de meia noite roda aqui (impossível pular o horário)
    }, 600000);

    // ⏱️ A CADA 2 HORAS (7.200.000 ms)
    setInterval(() => {
        cobrarMensalidades();
    }, 7200000);
});

// 📶 EVENTO DE MENSAGENS RECEBIDAS
client.on('message', async msg => {
    if (msg.type !== 'chat') return;

    const chat = await msg.getChat();
    if (chat.isGroup || msg.fromMe || msg.isBroadcast) return;

    const tempoAtual = Math.floor(Date.now() / 1000);
    const diferencaTempo = tempoAtual - msg.timestamp;
    if (diferencaTempo > 60) return;

    const userId = msg.from;

    if (!userStates[userId]) {
        userStates[userId] = { 
            step: 'idle', 
            lastBooking: 0, 
            justCanceled: false, 
            timeoutId: null,
            processing: false,
            lastMessageTimestamp: 0,
            spamScore: 0,
            blockedUntil: 0
        };
    }

    const agoraMili = Date.now();

    if (userStates[userId].blockedUntil && agoraMili < userStates[userId].blockedUntil) return;
    if (userStates[userId].processing) return;

    const intervaloMensagem = (agoraMili - userStates[userId].lastMessageTimestamp) / 1000;
    userStates[userId].lastMessageTimestamp = agoraMili;

    if (intervaloMensagem < 3.0) {
        userStates[userId].spamScore += 1;
        if (userStates[userId].spamScore >= 4) {
            userStates[userId].blockedUntil = agoraMili + 180000;
            userStates[userId].spamScore = 0;
            userStates[userId].step = 'idle'; 
            console.log(`🚨 [Anti-Loop] Possível loop de BOT detectado no número ${userId}. Bloqueado por 3 minutos.`);
            return;
        }
    } else {
        userStates[userId].spamScore = Math.max(0, userStates[userId].spamScore - 1);
    }

    userStates[userId].processing = true;

    if (userStates[userId].timeoutId) {
        clearTimeout(userStates[userId].timeoutId);
        userStates[userId].timeoutId = null;
    }

    const text = msg.body.toLowerCase();
    try {
        if (text === '#agenda') {
            const { data: barbeiro, error: authError } = await supabase
                .from('Barbeiros')
                .select('Telefone')
                .eq('Telefone', userId)
                .single();

            if (authError || !barbeiro) {
                console.log(`[Segurança] Comando #agenda ignorado para o número: ${userId}`);
                return;
            }

            const dataHoje = obterDataFormatada(0);
            const dataAmanha = obterDataFormatada(1);
            const dataDepois = obterDataFormatada(2);
            const dias = [dataHoje, dataAmanha, dataDepois];

            const { data: agendamentos, error: errAg } = await supabase
                .from('Agendamentos')
                .select('*')
                .in('Data', dias)
                .in('Status', ['Agendado', 'Aguardando Pagamento'])
                .order('Data', { ascending: true })
                .order('Horário', { ascending: true });

            if (errAg) {
                await responderComDigitando(chat, msg, 'Erro ao carregar a agenda.');
                return;
            }

            const formatarBr = (dataStr) => dataStr.split('-').reverse().slice(0,2).join('/');
            let resposta = '📋 *AGENDA DOS PRÓXIMOS 3 DIAS:*\n\n';

            dias.forEach(dia => {
                resposta += `📅 *Dia ${formatarBr(dia)}:*\n`;
                const filtrados = agendamentos ? agendamentos.filter(a => a.Data === dia) : [];
                if (filtrados.length === 0) {
                    resposta += ' Sem agendamentos para este dia.\n';
                } else {
                    filtrados.forEach(a => {
                        const statusIcon = a.Status === 'Agendado' ? '✅' : '⏳';
                        resposta += ` ${statusIcon} *${a.Horário}* - ${a.Nome} (${a.Serviço})\n`;
                    });
                }
                resposta += '\n';
            });

            await responderComDigitando(chat, msg, resposta.trim());
            return;
        }

        if (text === 'cancelar') {
            try {
                const { data: ags } = await supabase
                    .from('Agendamentos')
                    .select('*')
                    .eq('Telefone', userId)
                    .in('Status', ['Agendado', 'Aguardando Pagamento']);

                if (!ags || ags.length === 0) return responderComDigitando(chat, msg, 'Você não possui agendamentos ativos para cancelar.');
                for (const ag of ags) {
                    await supabase.from('Disponibilidade').update({ Status: 'Livre' }).eq('Horário', ag.Horário).eq('Data', ag.Data);
                    await supabase.from('Agendamentos').update({ Status: 'Cancelado' }).eq('id', ag.id);
                }
                
                await responderComDigitando(chat, msg, '✅ Agendamento cancelado com sucesso. O horário foi liberado.');
                userStates[userId].step = 'idle';
                userStates[userId].justCanceled = true; 
            } catch (e) { 
                return responderComDigitando(chat, msg, 'Erro ao processar cancelamento.');
            }
        }

        else if (userStates[userId].step === 'idle') {
            const agora = Date.now();
            const tempoPassado = (agora - userStates[userId].lastBooking) / 60000;
            
            if (tempoPassado >= 5) userStates[userId].justCanceled = false;
            if (userStates[userId].lastBooking !== 0 && tempoPassado < 5) {
                if (userStates[userId].justCanceled) {
                    return responderComDigitando(chat, msg, `⚠️ Calma lá! Seu agendamento anterior foi cancelado, mas você ainda precisa aguardar mais ${Math.ceil(5 - tempoPassado)} minuto(s) para realizar um novo agendamento no sistema. 💈`);
                } else {
                    return responderComDigitando(chat, msg, `⚠️ Calma lá! Aguarde mais ${Math.ceil(5 - tempoPassado)} minuto(s) para um novo agendamento, ou digite "cancelar" para desistir do seu horário atual.`);
                }
            }

            const palavrasChave = ['agendar', 'oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite'];
            if (palavrasChave.some(palavra => text.includes(palavra))) {
                userStates[userId].step = 'loading';
                try {
                    const { data: agendamentosAtivos } = await supabase
                        .from('Agendamentos')
                        .select('*')
                        .eq('Telefone', userId)
                        .in('Status', ['Agendado', 'Aguardando Pagamento']);

                    if (agendamentosAtivos && agendamentosAtivos.length > 0) {
                        const ag = agendamentosAtivos[0];
                        userStates[userId].step = 'idle';
                        userStates[userId].lastBooking = Date.now();
                        
                        if (ag.Status === 'Aguardando Pagamento') {
                            return responderComDigitando(chat, msg, `💈 Ei! Você já iniciou um agendamento de *${ag.Serviço}* para às *${ag.Horário}*, mas ele ainda está *Aguardando Pagamento*.\n\nSe preferir desistir e liberar essa vaga, digite *"cancelar"* a qualquer momento.`);
                        }
                        const diaMarcado = ag.Data.split('-').reverse().slice(0,2).join('/');
                        return responderComDigitando(chat, msg, `💈 Fala, campeão! Verifiquei no sistema e você já possui um horário de *${ag.Serviço}* pré-agendado para the dia *${diaMarcado}* às *${ag.Horário}*.\n\nSe houver algum imprevisto, basta digitar a palavra *"cancelar"* aqui a qualquer momento. Caso contrário, te esperamos lá! 👊`);
                    }

                    const { data: configRecord } = await supabase.from('Configuracoes').select('*').limit(1);
                    if (configRecord && configRecord.length > 0) {
                        if (configRecord[0].Modo_Ausente) {
                            await responderComDigitando(chat, msg, configRecord[0].Mensagem_Ausencia || '💈 Olá! No momento estamos ausentes e não estamos recebendo agendamentos. Voltaremos em breve!');
                            userStates[userId].step = 'idle';
                            return;
                        }
                    }

                    const dataHoje = obterDataFormatada(0);
                    const dataAmanha = obterDataFormatada(1);
                    const dataDepois = obterDataFormatada(2);

                    userStates[userId].diasDisponiveis = {
                        '1': dataHoje,
                        '2': dataAmanha,
                        '3': dataDepois
                    };

                    const formatarBr = (dataStr) => dataStr.split('-').reverse().slice(0,2).join('/');

                    userStates[userId].step = 'choosing_date';
                    await responderComDigitando(chat, msg, `💈 *Bem-vindo à barbearia Duas Faces!*\n\nPara quando você deseja agendar o seu horário?\n\n📅 *1.* Hoje (${formatarBr(dataHoje)})\n📅 *2.* Amanhã (${formatarBr(dataAmanha)})\n📅 *3.* Depois de Amanhã (${formatarBr(dataDepois)})\n\nDigite apenas o *número* da opção desejada:`);
                } catch (error) {
                    console.error(error);
                    await responderComDigitando(chat, msg, 'Erro ao acessar o sistema. Tente novamente.');
                    userStates[userId].step = 'idle';
                }
            }
        } 
        
        else if (userStates[userId].step === 'choosing_date') {
            const opcaoData = msg.body.trim();
            const dataEscolhida = userStates[userId].diasDisponiveis ? userStates[userId].diasDisponiveis[opcaoData] : null;

            if (!dataEscolhida) return responderComDigitando(chat, msg, '⚠️ Opção inválida. Digite 1 para Hoje, 2 para Amanhã ou 3 para Depois de Amanhã.');
            userStates[userId].dataSelecionada = dataEscolhida;

            try {
                const dataObj = new Date(dataEscolhida + "T12:00:00-03:00");
                const diaDaSemana = dataObj.getDay();

                if (diaDaSemana === 0) {
                    await responderComDigitando(chat, msg, '💈 Olá! A barbearia não abre aos domingos para descanso. Por favor, mande um "Oi" novamente e escolha outro dia! 👊');
                    userStates[userId].step = 'idle';
                    return;
                }

                const registros = await garantirHorariosDoDia(dataEscolhida, diaDaSemana);
                const horaAtualStr = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
                const dataHojeStr = obterDataFormatada(0);
                const registrosValidos = registros ? registros.filter(r => {
                    if (r.Status !== 'Livre') return false; 
                    
                    if (dataEscolhida === dataHojeStr) {
                        return r.Horário > horaAtualStr; 
                    }
                    return true;
                }) : [];

                if (registrosValidos.length === 0) {
                    await responderComDigitando(chat, msg, '🛑 Não temos mais horários livres disponíveis para o dia selecionado. Caso deseje, digite *"Oi"* para escolher outro dia! 💈');
                    userStates[userId].step = 'idle';
                } else {
                    userStates[userId].horariosDisponiveis = {};
                    let listaHorariosFormatada = '';
                    
                    registrosValidos.forEach((r, index) => {
                        const numeroOpcao = (index + 1).toString();
                        userStates[userId].horariosDisponiveis[numeroOpcao] = { hora: r.Horário, id: r.id };
                        listaHorariosFormatada += `⏰ *${numeroOpcao}.* ${r.Horário}\n`;
                    });
                    
                    userStates[userId].step = 'choosing_time';
                    await responderComDigitando(chat, msg, `Perfeito! Veja os horários ainda disponíveis para esta data:\n\n${listaHorariosFormatada}\nPor favor, digite apenas o *número* do horário desejado:`);
                }
            } catch (error) {
                console.error(error);
                await responderComDigitando(chat, msg, 'Erro ao carregar horários deste dia. Mande "oi" para recomeçar.');
                userStates[userId].step = 'idle';
            }
        }

        else if (userStates[userId].step === 'choosing_time') {
            const opcaoDigitada = msg.body.trim();
            const choice = userStates[userId].horariosDisponiveis ? userStates[userId].horariosDisponiveis[opcaoDigitada] : null;

            if (!choice) return responderComDigitando(chat, msg, '⚠️ Opção inválida.');

            userStates[userId].horarioEscolhido = choice.hora;
            userStates[userId].recordIdHorario = choice.id; 
            
            try {
                const { data: servicosRegs } = await supabase.from('Servicos').select('*').order('ID', { ascending: true });
                userStates[userId].servicosDisponiveis = {};
                let menuServicos = '';
                
                if (servicosRegs) {
                    servicosRegs.forEach((r, index) => {
                        const numeroOpcao = (index + 1).toString();
                        userStates[userId].servicosDisponiveis[numeroOpcao] = { nome: r.Nome, preco: r.Preco };
                        menuServicos += `🔹 *${numeroOpcao}.* ${r.Nome} — R$ ${r.Preco}\n`;
                    });
                }
                
                userStates[userId].step = 'choosing_service';
                await responderComDigitando(chat, msg, `Boa! Horário das ${choice.hora} pré-reservado.\n\nQual serviço você gostaria de fazer?\n\n${menuServicos}\nDigite apenas o *número* da opção desejada:`);
            } catch (error) {
                await responderComDigitando(chat, msg, 'Erro ao carregar os serviços. Envie "oi" para reiniciar.');
                userStates[userId].step = 'idle';
            }
        }

        else if (userStates[userId].step === 'choosing_service') {
            const opcao = msg.body.trim();
            const choiceServico = userStates[userId].servicosDisponiveis ? userStates[userId].servicosDisponiveis[opcao] : null;
            
            if (!choiceServico) return responderComDigitando(chat, msg, '⚠️ Opção inválida.');

            userStates[userId].nomeServicoPuro = choiceServico.nome;
            userStates[userId].precoServicoPuro = choiceServico.preco;
            userStates[userId].servicoEscolhido = `${choiceServico.nome} (R$ ${choiceServico.preco})`;
            
            userStates[userId].step = 'confirming_time_and_service';
            
            const diaVisual = userStates[userId].dataSelecionada.split('-').reverse().slice(0,2).join('/');
            await responderComDigitando(chat, msg, `Resumo do seu agendamento:\n📅 Data: *${diaVisual}*\n⏰ Horário: *${userStates[userId].horarioEscolhido}*\n✂️ Serviço: *${choiceServico.nome}*\n\nEstá correto?\n\n👍 *1.* Sim\n🔄 *2.* Não (Refazer escolha)`);
        }

        else if (userStates[userId].step === 'confirming_time_and_service') {
            const opcaoConfirmacao = msg.body.trim();
            if (opcaoConfirmacao === '1' || opcaoConfirmacao.toLowerCase() === 'sim') {
                userStates[userId].step = 'asking_name';
                await responderComDigitando(chat, msg, `Excelente! Agora, qual o seu *NOME E SOBRENOME* para avançarmos?`);
            } 
            else if (opcaoConfirmacao === '2' || opcaoConfirmacao.toLowerCase() === 'não' || opcaoConfirmacao.toLowerCase() === 'nao') {
                userStates[userId].step = 'idle';
                await responderComDigitando(chat, msg, `Sem problemas! Vamos recomeçar do zero para você escolher certinho.\n\nPor favor, digite *"agendar"* para eu carregar os horários atualizados! 💈`);
            } 
            else {
                return responderComDigitando(chat, msg, '⚠️ Opção inválida. Digite *1* para confirmar ou *2* para refazer sua escolha.');
            }
        }

        else if (userStates[userId].step === 'asking_name') {
            userStates[userId].nomeCliente = msg.body;
            userStates[userId].step = 'choosing_payment_method';
            
            await responderComDigitando(chat, msg, `Perfeito, *${userStates[userId].nomeCliente}*! Como você prefere realizar o pagamento?\n\n💵 *1.* Pagamento presencial na Barbearia (Dinheiro, Cartão de Crédito/Débito ou Pix)\n⚡ *2.* Pix (Pagamento Antecipado - Confirmação automática)\n💳 *3.* Cartão de Crédito (Pagamento Antecipado - Via link seguro)\n\nDigite apenas o *número* correspondente à sua escolha:`);
        }

        else if (userStates[userId].step === 'choosing_payment_method') {
            const opcaoPagamento = msg.body.trim();
            if (!['1', '2', '3'].includes(opcaoPagamento)) {
                return responderComDigitando(chat, msg, '⚠️ Opção inválida. Escolha entre:\n1 para Pagamento presencial na Barbearia\n2 para Pix\n3 para Cartão de Crédito');
            }

            let agendamentoIdParaRollback = null;
            try {
                await responderComDigitando(chat, msg, '⏳ Verificando disponibilidade e preparando o sistema...');
                const { data: checagemAtual } = await supabase.from('Disponibilidade').select('Status').eq('id', userStates[userId].recordIdHorario).single();
                
                if (!checagemAtual || checagemAtual.Status !== 'Livre') {
                    await responderComDigitando(chat, msg, `🛑 *Ops!* Outro cliente acabou de finalizar uma reserva nesse mesmo horário. Envie "oi" para recomeçar!`);
                    userStates[userId].step = 'idle';
                    return;
                }

                const dataCorreta = userStates[userId].dataSelecionada;
                const diaVisualFinal = dataCorreta.split('-').reverse().join('/');

                if (opcaoPagamento === '1') {
                    await supabase.from('Agendamentos').insert([{ 
                        "Data": dataCorreta, "Nome": userStates[userId].nomeCliente, 
                        "Horário": userStates[userId].horarioEscolhido, "Serviço": userStates[userId].servicoEscolhido, 
                        "Valor": Number(userStates[userId].precoServicoPuro),
                        "Status": "Agendado", "Telefone": userId 
                    }]);
                    await supabase.from('Disponibilidade').update({ Status: 'Ocupado' }).eq('id', userStates[userId].recordIdHorario);
                    await responderComDigitando(chat, msg, `✅ Tudo certo, ${userStates[userId].nomeCliente}! Seu horário de *${userStates[userId].servicoEscolhido}* foi agendado com sucesso para the dia *${diaVisualFinal}*!\n\nO pagamento poderá ser feito diretamente na barbearia. Te esperamos às *${userStates[userId].horarioEscolhido}*! 👊`);
                    await enviarComDigitando(chat, '📍 *Aqui está a nossa localização no Google Maps:* \n\nhttps://maps.app.goo.gl/kneNwDiQREA6GqUBA'); 

                    userStates[userId].lastBooking = Date.now();
                    userStates[userId].step = 'idle';
                }

                else if (opcaoPagamento === '2') {
                    const { data: novoAgendamento } = await supabase.from('Agendamentos').insert([{ 
                        "Data": dataCorreta, "Nome": userStates[userId].nomeCliente, 
                        "Horário": userStates[userId].horarioEscolhido, "Serviço": userStates[userId].servicoEscolhido, 
                        "Valor": Number(userStates[userId].precoServicoPuro),
                        "Status": "Aguardando Pagamento", "Telefone": userId 
                    }]).select();
                    agendamentoIdParaRollback = novoAgendamento[0].id; 
                    await supabase.from('Disponibilidade').update({ Status: 'Ocupado' }).eq('id', userStates[userId].recordIdHorario);
                    
                    const responseMP = await fetch('https://api.mercadopago.com/v1/payments', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.MERCADO_PAGO_TOKEN}`,
                            'Content-Type': 'application/json',
                            'X-Idempotency-Key': String(Date.now())
                        },
                        body: JSON.stringify({
                            transaction_amount: Number(userStates[userId].precoServicoPuro),
                            description: `Agendamento - ${userStates[userId].nomeServicoPuro}`,
                            payment_method_id: 'pix',
                            payer: { email: 'cliente@barbersync.com' },
                            external_reference: String(agendamentoIdParaRollback)
                        })
                    });
                    const dataMP = await responseMP.json();
                    const pixCopiaCola = dataMP.point_of_interaction?.transaction_data?.qr_code;

                    if (!pixCopiaCola) throw new Error('Erro ao gerar código Pix.');
                    
                    // 🪵 LOG ADICIONADO: Exibe apenas o nome do cliente que gerou o Pix
                    console.log(`⚡ [Sistema] Código Pix gerado com sucesso para o cliente: ${userStates[userId].nomeCliente}`);
                    
                    await supabase.from('Agendamentos').update({ ID_Pagamento_MP: String(dataMP.id) }).eq('id', agendamentoIdParaRollback);
                    
                    await responderComDigitando(chat, msg, `⚡ Perfeito! Para confirmar seu horário do dia *${diaVisualFinal}* às *${userStates[userId].horarioEscolhido}*, utilize o código Pix Copia e Cola que estou enviando na mensagem abaixo 👇`);
                    await client.sendMessage(userId, pixCopiaCola);
                    await enviarComDigitando(chat, `👆 *Copie apenas a mensagem acima*, abra o aplicativo do seu banco e use a opção "Pix Copia e Cola". Nosso sistema identificará o pagamento e confirmará tudo em instantes!`);
                    userStates[userId].step = 'idle';
                }

                else if (opcaoPagamento === '3') {
                    const { data: novoAgendamento } = await supabase.from('Agendamentos').insert([{ 
                        "Data": dataCorreta, "Nome": userStates[userId].nomeCliente, 
                        "Horário": userStates[userId].horarioEscolhido, "Serviço": userStates[userId].servicoEscolhido, 
                        "Valor": Number(userStates[userId].precoServicoPuro),
                        "Status": "Aguardando Pagamento", "Telefone": userId 
                    }]).select();
                    agendamentoIdParaRollback = novoAgendamento[0].id; 
                    await supabase.from('Disponibilidade').update({ Status: 'Ocupado' }).eq('id', userStates[userId].recordIdHorario);
                    
                    const responseMP = await fetch('https://api.mercadopago.com/checkout/preferences', { 
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.MERCADO_PAGO_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            items: [{
                                title: `Agendamento - ${userStates[userId].nomeServicoPuro}`,
                                quantity: 1,
                                unit_price: Number(userStates[userId].precoServicoPuro),
                                currency_id: 'BRL'
                            }],
                            external_reference: String(agendamentoIdParaRollback),
                            back_urls: { 
                                success: 'https://seusite.com/sucesso',
                                failure: 'https://seusite.com/falha',
                                pending: 'https://seusite.com/pendente' 
                            },
                            auto_return: 'approved'
                        })
                    });
                    const dataMP = await responseMP.json();
                    const linkCartao = dataMP.init_point;

                    if (!linkCartao) throw new Error('Erro ao gerar Preference Link.');
                    
                    // 🪵 LOG ADICIONADO: Exibe apenas o nome do cliente que gerou o Link de Cartão
                    console.log(`💳 [Sistema] Link de Cartão gerado com sucesso para o cliente: ${userStates[userId].nomeCliente}`);
                    
                    await supabase.from('Agendamentos').update({ ID_Pagamento_MP: String(dataMP.id) }).eq('id', agendamentoIdParaRollback);
                    
                    await responderComDigitando(chat, msg, `💳 Excelente! Clique no link seguro abaixo para realizar o pagamento com seu Cartão de Crédito:\n\n${linkCartao}\n\nAssim que o pagamento for aprovado, o sistema atualizará o seu horário automaticamente!`);
                    userStates[userId].step = 'idle';
                }

            } catch (error) {
                console.error("❌ ERRO NO FLUXO DE PAGAMENTO:", error);
                if (agendamentoIdParaRollback) {
                    try {
                        await supabase.from('Agendamentos').delete().eq('id', agendamentoIdParaRollback);
                        await supabase.from('Disponibilidade').update({ Status: 'Livre' }).eq('id', userStates[userId].recordIdHorario);
                    } catch (rollbackError) {
                        console.error("❌ Falha crítica ao tentar desfazer (Rollback):", rollbackError);
                    }
                }

                await responderComDigitando(chat, msg, '⚠️ Houve um problema de comunicação com o sistema de pagamento e sua vaga não foi reservada.\n\nFique tranquilo, o horário foi liberado novamente. Por favor, digite "agendar" e tente de novo.');
                userStates[userId].step = 'idle';
            }
        }
    } catch (globalError) {
        console.error("❌ Erro catastrófico no processamento de fluxo:", globalError);
    } finally {
        userStates[userId].processing = false;
        if (userStates[userId].step !== 'idle') {
            userStates[userId].timeoutId = setTimeout(async () => {
                try {
                    if (userStates[userId].step !== 'idle') {
                        userStates[userId].step = 'idle';
                        await enviarComDigitando(chat, "⏳ *Atendimento encerrado por inatividade!*\n\nComo ficamos muito tempo sem resposta, finalizei o seu atendimento para não congestionar o nosso sistema.\n\nQuando quiser agendar novamente, é só mandar um *'Oi'*! 💈");
                    }
                } catch (err) {
                    console.error(err);
                }
            }, 120000);
        }
    }
});

// 🌐 ROTA DE WEBHOOK DO MERCADO PAGO ATUALIZADA
app.post('/webhook', async (req, res) => {
    console.log("📥 [Webhook] Recebi um aviso do Mercado Pago!");
    res.sendStatus(200);

    const { data } = req.body;
    const paymentId = data?.id || req.query.id;

    if (!paymentId) return;

    try {
        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${process.env.MERCADO_PAGO_TOKEN}` }
        });
        const paymentData = await response.json();

        // 🟢 CASO 1: PAGAMENTO APROVADO
        if (paymentData.status === 'approved') {
            const agendamentoId = paymentData.external_reference;
            const { data: agendamento } = await supabase.from('Agendamentos').select('*').eq('id', agendamentoId).single();
            
            if (agendamento && agendamento.Status === 'Aguardando Pagamento') {
                await supabase.from('Agendamentos').update({ Status: 'Agendado' }).eq('id', agendamentoId);
                const telefoneCliente = agendamento.Telefone;
                const nomeCliente = agendamento.Nome;
                const horario = agendamento.Horário;
                const servico = agendamento.Serviço;
                const diaVisual = agendamento.Data.split('-').reverse().join('/');
                try {
                    const chat = await client.getChatById(telefoneCliente);
                    await chat.sendStateTyping();
                    await delay(1000); 
                    
                    await client.sendMessage(telefoneCliente, `🎉 *Pagamento Confirmado!* \n\nPerfeito, ${nomeCliente}! Seu pagamento foi aprovado pelo Mercado Pago e o seu horário de *${servico}* está 100% confirmado para o dia *${diaVisual}* às *${horario}*.\n\nMuito obrigado! Estamos te esperando! 💈💈`);
                    await client.sendMessage(telefoneCliente, '📍 *Aqui está a nossa localização no Google Maps caso precise:* \n\nhttps://maps.app.goo.gl/kneNwDiQREA6GqUBA');
                } catch (err) {
                    console.error("Erro ao enviar mensagem de webhook via whatsapp", err);
                }
            }
        }
        
        // 🔴 CASO 2: PAGAMENTO RECUSADO/FALHOU (NOVA LÓGICA)
        else if (paymentData.status === 'rejected') {
            const agendamentoId = paymentData.external_reference;
            const { data: agendamento } = await supabase.from('Agendamentos').select('*').eq('id', agendamentoId).single();
            
            if (agendamento && agendamento.Status === 'Aguardando Pagamento') {
                // 1. Libera o horário na tabela de Disponibilidade
                await supabase.from('Disponibilidade').update({ Status: 'Livre' }).eq('Horário', agendamento.Horário).eq('Data', agendamento.Data);
                
                // 2. Cancela o agendamento no banco
                await supabase.from('Agendamentos').update({ Status: 'Cancelado' }).eq('id', agendamentoId);
                
                const telefoneCliente = agendamento.Telefone;
                const nomeCliente = agendamento.Nome;
                
                console.log(`⚠️ [Webhook] Pagamento do cliente ${nomeCliente} foi recusado. Horário das ${agendamento.Horário} liberado.`);
                
                try {
                    const chat = await client.getChatById(telefoneCliente);
                    await chat.sendStateTyping();
                    await delay(1000); 
                    
                    // 3. Avisa o cliente imediatamente no WhatsApp
                    await client.sendMessage(telefoneCliente, `⚠️ *Ops, Pagamento Não Aprovado!*\n\nFala, ${nomeCliente}. O Mercado Pago nos informou que a sua tentativa de pagamento foi *recusada* (pode ser saldo insuficiente, cartão bloqueado ou dados incorretos).\n\nComo o pagamento falhou, sua reserva foi cancelada para liberar o horário. Caso queira tentar de novo com outro cartão, pix ou pagar no estabelecimento, basta mandar um *"Oi"* para reiniciar! 💈👊`);
                } catch (errWpp) {
                    console.error("Erro ao enviar mensagem de recusa via whatsapp", errWpp);
                }
            }
        }
    } catch (error) {
        console.error("❌ Erro ao processar o Webhook:", error);
    }
});

// Inicializa o servidor Express e o Cliente WhatsApp
app.listen(PORT, () => console.log(`🌐 Servidor Webhook rodando na porta ${PORT}`)); 
client.initialize();