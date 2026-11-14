using System.Windows.Forms;

// Integration-test application only. This is NOT an Android-to-Windows port or a Store listing.
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        using var form = new Form { Text = "AEM native pipeline test", Width = 500, Height = 180 };
        form.Controls.Add(new Label { Text = "Native WinForms build-test fixture. Not an Android port.", Dock = DockStyle.Fill });
        form.Shown += (_, _) => {
            if (args.Length == 2 && args[0] == "--smoke-file") {
                File.WriteAllText(args[1], "native-window-shown");
                form.Close();
            }
        };
        Application.Run(form);
    }
}
