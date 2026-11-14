// Launcher: starts the Node server hidden, opens the page in an Edge app window, and stays in the tray.
// Built twice by build.ps1: with /define:VOZ it opens the voice assistant, without it the command center.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string Title = "Centro de Comando";
    const string VozSize = " --window-size=400,620";
    static readonly string Dir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory));
    static int Port = 7777;
    static Process server;

    [STAThread]
    static void Main()
    {
#if VOZ
        string page = "/voz", size = VozSize;
#else
        string page = "/", size = "";
#endif
        try
        {
            var m = Regex.Match(File.ReadAllText(Path.Combine(Dir, "config.json")), "\"port\"\\s*:\\s*(\\d+)");
            if (m.Success) Port = int.Parse(m.Groups[1].Value);
        }
        catch { }

        bool first;
        using (var mutex = new Mutex(true, "CentroDeComando.Tray", out first))
        {
            // Tray already running: just open another window.
            if (!first) { Open(page, size); return; }

            if (!Up())
            {
                if (!Directory.Exists(Path.Combine(Dir, "node_modules")))
                {
                    Fail("Dependências não instaladas. Rode \"npm install\" na pasta:\n" + Dir);
                    return;
                }
                if (!StartServer()) return;
            }
            if (!WaitUp()) { Fail("O servidor não iniciou. Veja server.log em:\n" + Dir); Stop(); return; }

            Open(page, size);
            Tray(page, size);
            Stop();
        }
    }

    static string Url(string page) { return "http://127.0.0.1:" + Port + page; }

    static bool Up()
    {
        try
        {
            var r = (HttpWebRequest)WebRequest.Create(Url("/"));
            r.Timeout = 1000;
            using (r.GetResponse()) return true;
        }
        catch { return false; }
    }

    static bool WaitUp()
    {
        for (int i = 0; i < 60; i++)
        {
            if (Up()) return true;
            if (server != null && server.HasExited) return false;
            Thread.Sleep(250);
        }
        return false;
    }

    static bool StartServer()
    {
        try
        {
            var psi = new ProcessStartInfo("node.exe", "server.js")
            {
                WorkingDirectory = Dir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            server = Process.Start(psi);
            var log = new StreamWriter(Path.Combine(Dir, "server.log"), false) { AutoFlush = true };
            DataReceivedEventHandler write = (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
            server.OutputDataReceived += write;
            server.ErrorDataReceived += write;
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
            return true;
        }
        catch (Exception e)
        {
            Fail("Não foi possível iniciar o Node.js (" + e.Message + ").\nInstale com: winget install OpenJS.NodeJS.LTS");
            return false;
        }
    }

    static void Stop()
    {
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
    }

    static void Open(string page, string size)
    {
        try { Process.Start("msedge", "--app=" + Url(page) + size); }
        catch { Process.Start(Url(page)); }   // no Edge: default browser
    }

    static void Tray(string page, string size)
    {
        var icon = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
            Text = Title,
            Visible = true,
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Assistente de voz", null, (s, e) => Open("/voz", VozSize));
        menu.Items.Add("Central de Comando", null, (s, e) => Open("/", ""));
        menu.Items.Add("Abrir pasta", null, (s, e) => Process.Start(Dir));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Sair (desliga o servidor)", null, (s, e) => { icon.Visible = false; Application.Exit(); });
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (s, e) => Open(page, size);
        Application.Run();
        icon.Dispose();
    }

    static void Fail(string msg)
    {
        MessageBox.Show(msg, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
