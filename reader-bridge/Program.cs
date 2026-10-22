using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using ReaderB;

namespace KL9007ReaderBridge
{
    internal static class Program
    {
        private static volatile bool _running = true;
        private static int _comIndex = -1;
        private static byte _readerAddress = 0xFF;
        private static byte[] _buzzerEnabledSetting;
        private static byte[] _buzzerDisabledSetting;
        private static readonly HashSet<string> ActiveCards = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, DateTime> LastSeen = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
            {
                eventArgs.Cancel = true;
                _running = false;
            };

            int requestedPort = ParsePort(args);
            int port = requestedPort;
            byte baud = 5; // 厂商 Demo 默认值，对应 57600bps。
            int openResult;

            try
            {
                openResult = requestedPort > 0
                    ? StaticClassReaderB.OpenComPort(requestedPort, ref _readerAddress, baud, ref _comIndex)
                    : StaticClassReaderB.AutoOpenComPort(ref port, ref _readerAddress, baud, ref _comIndex);

                if (openResult != 0)
                {
                    WriteEvent("error", "code", openResult.ToString(), "message", "无法打开读写器串口");
                    return 2;
                }

                byte[] version = new byte[2];
                byte readerType = 0;
                byte[] protocols = new byte[2];
                byte maxFrequency = 0;
                byte minFrequency = 0;
                byte power = 0;
                byte scanTime = 0;
                int infoResult = StaticClassReaderB.GetReaderInformation(
                    ref _readerAddress,
                    version,
                    ref readerType,
                    protocols,
                    ref maxFrequency,
                    ref minFrequency,
                    ref power,
                    ref scanTime,
                    _comIndex);

                if (infoResult != 0)
                {
                    WriteEvent("error", "code", infoResult.ToString(), "message", "串口已打开，但无法读取设备信息");
                    return 3;
                }

                if (HasArgument(args, "--diagnose-buzzer") || HasArgument(args, "--enable-buzzer"))
                {
                    return ConfigureBuzzer(HasArgument(args, "--enable-buzzer"));
                }

                byte targetPower = ParsePower(args, 8);
                if (power != targetPower)
                {
                    int powerResult = StaticClassReaderB.SetPowerDbm(ref _readerAddress, targetPower, _comIndex);
                    if (powerResult == 0) power = targetPower;
                    WriteEvent("power", "result", powerResult.ToString(), "value", targetPower.ToString());
                }

                PrepareControlledBuzzer();

                WriteEvent(
                    "connected",
                    "port", "COM" + port,
                    "firmware", version[0].ToString("00") + "." + version[1].ToString("00"),
                    "readerType", readerType.ToString(),
                    "power", power.ToString());

                while (_running)
                {
                    InventoryOnce();
                    Thread.Sleep(180);
                }

                return 0;
            }
            catch (DllNotFoundException error)
            {
                WriteEvent("error", "message", "缺少 Basic.dll：" + error.Message);
                return 4;
            }
            catch (BadImageFormatException error)
            {
                WriteEvent("error", "message", "DLL 位数不匹配：" + error.Message);
                return 5;
            }
            catch (Exception error)
            {
                WriteEvent("error", "message", error.Message);
                return 1;
            }
            finally
            {
                if (_comIndex >= 0)
                {
                    try { StaticClassReaderB.CloseSpecComPort(_comIndex); }
                    catch { }
                }
                WriteEvent("disconnected");
            }
        }

        private static int ParsePort(string[] args)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (!string.Equals(args[index], "--port", StringComparison.OrdinalIgnoreCase)) continue;
                string value = args[index + 1].Trim().ToUpperInvariant().Replace("COM", "");
                int port;
                if (int.TryParse(value, out port) && port > 0) return port;
            }
            return 0;
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (string argument in args)
            {
                if (string.Equals(argument, expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static byte ParsePower(string[] args, byte fallback)
        {
            for (int index = 0; index < args.Length - 1; index++)
            {
                if (!string.Equals(args[index], "--power", StringComparison.OrdinalIgnoreCase)) continue;
                byte value;
                if (byte.TryParse(args[index + 1], out value) && value <= 30) return value;
            }
            string configured = Environment.GetEnvironmentVariable("KL9007_POWER_DBM");
            byte environmentValue;
            return byte.TryParse(configured, out environmentValue) && environmentValue <= 30
                ? environmentValue
                : fallback;
        }

        private static byte[] CreateWorkModeSetting(byte[] current, bool buzzerEnabled)
        {
            byte[] setting = new byte[6];
            setting[0] = current[4];
            setting[1] = buzzerEnabled
                ? Convert.ToByte(current[5] & 0xFB)
                : Convert.ToByte(current[5] | 0x04);
            setting[2] = current[6];
            setting[3] = current[7];
            setting[4] = current[8];
            setting[5] = current[9];
            return setting;
        }

        private static void PrepareControlledBuzzer()
        {
            byte[] current = new byte[12];
            int result = StaticClassReaderB.GetWorkModeParameter(ref _readerAddress, current, _comIndex);
            if (result != 0) return;
            _buzzerEnabledSetting = CreateWorkModeSetting(current, true);
            _buzzerDisabledSetting = CreateWorkModeSetting(current, false);
            StaticClassReaderB.SetWorkMode(ref _readerAddress, _buzzerDisabledSetting, _comIndex);
        }

        private static bool PulseHardwareBuzzer()
        {
            if (_buzzerEnabledSetting == null || _buzzerDisabledSetting == null) return false;
            int result = StaticClassReaderB.SetWorkMode(ref _readerAddress, _buzzerEnabledSetting, _comIndex);
            if (result != 0) return false;
            try
            {
                byte[] buffer = new byte[5000];
                int totalLength = 0;
                int cardCount = 0;
                StaticClassReaderB.Inventory_G2(
                    ref _readerAddress, 0, 0, 0, buffer, ref totalLength, ref cardCount, _comIndex);
                return cardCount > 0;
            }
            finally
            {
                StaticClassReaderB.SetWorkMode(ref _readerAddress, _buzzerDisabledSetting, _comIndex);
            }
        }

        private static int ConfigureBuzzer(bool enable)
        {
            byte[] current = new byte[12];
            int result = StaticClassReaderB.GetWorkModeParameter(ref _readerAddress, current, _comIndex);
            if (result != 0)
            {
                WriteEvent("buzzer", "result", result.ToString(), "message", "无法读取蜂鸣器配置");
                return 6;
            }

            bool wasEnabled = (current[5] & 0x04) == 0;
            WriteEvent(
                "buzzer",
                "result", "0",
                "enabled", wasEnabled ? "true" : "false",
                "workMode", current[4].ToString(),
                "parameter", current[5].ToString("X2"));

            if (!enable || wasEnabled) return 0;

            byte[] setting = CreateWorkModeSetting(current, true);
            result = StaticClassReaderB.SetWorkMode(ref _readerAddress, setting, _comIndex);
            WriteEvent(
                "buzzer-updated",
                "result", result.ToString(),
                "enabled", result == 0 ? "true" : "false",
                "workMode", setting[0].ToString(),
                "parameter", setting[1].ToString("X2"));
            return result == 0 ? 0 : 7;
        }

        private static void InventoryOnce()
        {
            byte[] buffer = new byte[5000];
            int totalLength = 0;
            int cardCount = 0;
            int result = StaticClassReaderB.Inventory_G2(
                ref _readerAddress,
                0,
                0,
                0,
                buffer,
                ref totalLength,
                ref cardCount,
                _comIndex);

            DateTime now = DateTime.UtcNow;
            if (result == 1 || result == 2 || result == 3 || result == 4 || result == 0xFB)
            {
                int offset = 0;
                for (int index = 0; index < cardCount && offset < totalLength; index++)
                {
                    int length = buffer[offset];
                    if (length <= 0 || offset + length >= totalLength + 1) break;
                    string epc = BytesToHex(buffer, offset + 1, length);
                    LastSeen[epc] = now;
                    if (ActiveCards.Add(epc))
                    {
                        PulseHardwareBuzzer();
                        WriteEvent("card", "uid", epc, "protocol", "EPC-C1G2");
                    }
                    offset += length + 1;
                }
            }

            List<string> removed = new List<string>();
            foreach (string epc in ActiveCards)
            {
                DateTime seen;
                if (!LastSeen.TryGetValue(epc, out seen) || (now - seen).TotalMilliseconds > 3000)
                    removed.Add(epc);
            }
            foreach (string epc in removed) ActiveCards.Remove(epc);
        }

        private static string BytesToHex(byte[] data, int offset, int length)
        {
            StringBuilder builder = new StringBuilder(length * 2);
            for (int index = 0; index < length; index++) builder.Append(data[offset + index].ToString("X2"));
            return builder.ToString();
        }

        private static void WriteEvent(string type, params string[] values)
        {
            StringBuilder json = new StringBuilder();
            json.Append("{\"type\":\"").Append(Escape(type)).Append("\"");
            for (int index = 0; index + 1 < values.Length; index += 2)
            {
                json.Append(",\"").Append(Escape(values[index])).Append("\":\"")
                    .Append(Escape(values[index + 1])).Append("\"");
            }
            json.Append("}");
            Console.WriteLine(json.ToString());
            Console.Out.Flush();
        }

        private static string Escape(string value)
        {
            return (value ?? string.Empty)
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
        }
    }
}
