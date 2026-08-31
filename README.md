# Windows publishing/build failure codes useful list:

Code	Common meaning

0	Success / no error
1	Generic application error
2	File or directory not found
3	Path not found
5	Access denied / insufficient permissions
6	Invalid handle
15	Drive not found
32	File locked / being used by another process
53	Network path not found
80	File already exists
87	Invalid parameter
112	Not enough disk space
122	Buffer/data too large
126	Required module/DLL not found
127	Required procedure/function not found
129	Application failed to initialise
193	Not a valid Win32 application
206	File/path name too long
740	Administrator privileges required
1001	Generic installer/publishing failure in some tools
1603	Fatal Windows Installer error
1618	Another installation already running
1638	Another version already installed
1641	Installation completed and restart initiated
3010	Installation completed; restart required


For a .exe publishing pipeline

You will also commonly see tool-specific exit codes, for example:

Exit code 0  = Build succeeded
Exit code 1  = Build failed
Exit code 2  = Invalid command/argument
Exit code 3  = Missing file/path
Exit code 5  = Permission denied
Exit code 126 = Executable/dependency could not be loaded
Exit code 127 = Command/tool not found
Exit code 193 = Invalid executable format
