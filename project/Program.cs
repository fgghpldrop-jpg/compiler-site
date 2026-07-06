using System;

class Program
{
    static void Main()
    {
        double x = 2, y = 3, z = 1;
        double b = (1 + Math.Pow(Math.Cos(x + z), 2)) / Math.Abs(Math.Pow(x, 3) - 2 * Math.Pow(y, 2));
        Console.WriteLine($"x={x}, y={y}, z={z}, b={b}");

        Console.Write("x = "); x = double.Parse(Console.ReadLine()!);
        Console.Write("y = "); y = double.Parse(Console.ReadLine()!);
        Console.Write("z = "); z = double.Parse(Console.ReadLine()!);
        b = (1 + Math.Pow(Math.Cos(x + z), 2)) / Math.Abs(Math.Pow(x, 3) - 2 * Math.Pow(y, 2));
        Console.WriteLine($"x={x}, y={y}, z={z}, b={b}");
    }
}