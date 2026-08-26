import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserSession } from '../entities/user-session.entity';
import { MailService } from '../../../infra/mail/mail.service';
import { maskEmail } from '../../../shared/logging/log-sanitizer.util';
import { maskIpAddress } from '../../../shared/security/evidence-integrity.util';

/**
 * Serviço de detecção de anomalias em logins.
 *
 * Compara o IP do login atual com os IPs das últimas sessões do usuário.
 * Se o prefixo de rede for completamente novo (nunca visto antes),
 * envia um e-mail de alerta para o usuário.
 *
 * Critérios de anomalia (heurística de subnet):
 *   - IPv4: os primeiros 2 octetos diferem de todos os IPs recentes → alerta
 *   - IPv6: os primeiros 4 grupos diferem → alerta
 *   - IPs internos (127.x, 10.x, 192.168.x, ::1) são ignorados
 *
 * O alerta é "best effort": falhas de envio de e-mail são logadas mas
 * nunca interrompem o fluxo de login.
 */
@Injectable()
export class LoginAnomalyService {
  private readonly logger = new Logger(LoginAnomalyService.name);

  /** Quantas sessões recentes verificar ao calcular o baseline de IPs. */
  private readonly RECENT_SESSIONS_LIMIT = 10;

  constructor(
    @InjectRepository(UserSession)
    private readonly sessionRepository: Repository<UserSession>,
    private readonly mailService: MailService,
  ) {}

  /**
   * Verifica se o IP do novo login é anômalo em relação ao histórico.
   * Deve ser chamado APÓS a sessão ser persistida, de forma não-bloqueante.
   */
  async checkAndAlert(params: {
    userId: string;
    userName: string;
    userEmail: string;
    currentIp: string;
    userAgent?: string;
    companyId: string;
  }): Promise<void> {
    const { userId, userName, userEmail, currentIp, userAgent, companyId } =
      params;

    if (!currentIp || this.isInternalIp(currentIp)) {
      return;
    }

    try {
      const recentSessions = await this.sessionRepository.find({
        where: { user_id: userId, is_active: true },
        order: { created_at: 'DESC' },
        take: this.RECENT_SESSIONS_LIMIT,
        select: ['ip', 'created_at'],
      });

      // Primeira sessão ever — sem baseline para comparar
      if (recentSessions.length <= 1) {
        return;
      }

      // Sessões anteriores (exclui a mais recente que acabou de ser criada)
      const previousIps = recentSessions
        .slice(1)
        .map((s) => s.ip)
        .filter((ip): ip is string => Boolean(ip) && !this.isInternalIp(ip));

      if (previousIps.length === 0) {
        return;
      }

      const currentPrefix = this.extractNetworkPrefix(currentIp);
      if (!currentPrefix) {
        return;
      }

      const knownPrefixes = new Set(
        previousIps.map((ip) => this.extractNetworkPrefix(ip)).filter(Boolean),
      );

      if (knownPrefixes.has(currentPrefix)) {
        // IP dentro de prefixo já visto — sem anomalia
        return;
      }

      // Prefixo de rede novo → possível login de localização diferente
      this.logger.warn({
        event: 'login_new_ip_prefix',
        severity: 'MEDIUM',
        userId,
        currentIp: maskIpAddress(currentIp),
        currentPrefix,
        knownPrefixes: [...knownPrefixes],
      });

      await this.sendAnomalyAlert({
        userName,
        userEmail,
        currentIp,
        userAgent,
        companyId,
      });
    } catch (error) {
      // Nunca bloqueia o login por falha de detecção
      this.logger.error({
        event: 'login_anomaly_check_failed',
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendAnomalyAlert(params: {
    userName: string;
    userEmail: string;
    currentIp: string;
    userAgent?: string;
    companyId: string;
  }): Promise<void> {
    const { userName, userEmail, currentIp, userAgent, companyId } = params;
    const now = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });
    const subject = 'Alerta de segurança: Acesso de novo endereço de rede';
    const html = `
      <h2 style="color:#b91c1c;">Acesso detectado de localização desconhecida</h2>
      <p>Olá, <strong>${this.escapeHtml(userName)}</strong>.</p>
      <p>Detectamos um acesso à sua conta a partir de um endereço de rede que não foi utilizado anteriormente.</p>
      <table style="border-collapse:collapse;width:100%;max-width:500px;">
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;">Data/Hora</td>
            <td style="padding:8px;border:1px solid #e5e7eb;">${now} (Brasília)</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;">Endereço IP</td>
            <td style="padding:8px;border:1px solid #e5e7eb;">${this.escapeHtml(currentIp)}</td></tr>
        <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;">Dispositivo</td>
            <td style="padding:8px;border:1px solid #e5e7eb;">${this.escapeHtml(userAgent?.slice(0, 120) || 'Desconhecido')}</td></tr>
      </table>
      <p style="margin-top:16px;">
        Se foi você, <strong>ignore este e-mail</strong>.
        Caso contrário, altere sua senha imediatamente e entre em contato com o suporte.
      </p>
      <p style="color:#6b7280;font-size:12px;">
        Este é um aviso automático do Sistema de Gestão de Segurança (SGS).
      </p>
    `;

    try {
      await this.mailService.sendMail(
        userEmail,
        subject,
        'Alerta de acesso de localização desconhecida.',
        html,
        { companyId },
      );
      this.logger.log({
        event: 'login_anomaly_alert_sent',
        email: maskEmail(userEmail),
        ip: maskIpAddress(currentIp),
      });
    } catch (error) {
      this.logger.error({
        event: 'login_anomaly_alert_failed',
        email: maskEmail(userEmail),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Retorna prefixo de rede para comparação. */
  private extractNetworkPrefix(ip: string): string | null {
    const clean = ip.replace(/^::ffff:/, ''); // normaliza IPv4-mapeado em IPv6

    // IPv4: usa os dois primeiros octetos (ex: "192.168")
    const ipv4Match = clean.match(/^(\d{1,3}\.\d{1,3})\.\d/);
    if (ipv4Match) {
      return `v4:${ipv4Match[1]}`;
    }

    // IPv6: usa os primeiros 4 grupos (ex: "2804:14d::")
    const ipv6Parts = clean.split(':');
    if (ipv6Parts.length >= 3) {
      return `v6:${ipv6Parts.slice(0, 4).join(':')}`;
    }

    return null;
  }

  /** IPs de loopback e redes privadas — sem significado geográfico. */
  private isInternalIp(ip: string): boolean {
    const clean = ip.replace(/^::ffff:/, '');
    return (
      clean === '::1' ||
      clean === '127.0.0.1' ||
      clean.startsWith('10.') ||
      clean.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(clean)
    );
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
